package server

import (
	"bytes"
	"io/fs"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type Hub struct {
	mu       sync.Mutex
	clients  map[*websocket.Conn]struct{}
	pending  []byte   // 跨调用缓冲，解决 WS 分包/粘包
	gopCache [][]byte // 最近一组：SPS、PPS、IDR（均为 Annex-B，含起始码）
	spsMsg   []byte
	ppsMsg   []byte
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*websocket.Conn]struct{}),
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// 与 main.go 匹配：启动静态页 + 注册 WS
func (h *Hub) Serve(addr string, content fs.FS, wsPath string) error {
	http.Handle("/", http.FileServer(http.FS(content)))
	http.HandleFunc(wsPath, h.handleWS)
	return http.ListenAndServe(addr, nil)
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	h.mu.Lock()
	h.clients[ws] = struct{}{}
	// 新连上：先推缓存（若有）
	for _, frame := range h.gopCache {
		_ = ws.WriteMessage(websocket.BinaryMessage, frame)
	}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, ws)
		h.mu.Unlock()
		_ = ws.Close()
	}()

	// 读丢弃以保持连接
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			return
		}
	}
}

// 与 main.go 匹配：接收原始块，解析为 NAL，维护缓存并广播
func (h *Hub) Broadcast(p []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// 追加到 pending 并尽量切出完整 NAL（Annex-B）
	h.pending = append(h.pending, p...)
	nals, rest := cutNALs(h.pending)
	h.pending = rest

	// 逐个 NAL 处理
	for _, msg := range nals {
		t := nalType(msg)
		switch t {
		case 7: // SPS
			h.spsMsg = msg
			// 不是立即清 cache，等到 IDR 时组合
		case 8: // PPS
			h.ppsMsg = msg
		case 5: // IDR，生成新的 GOP 缓存（SPS/PPS 可能为空，尽量带上）
			var g [][]byte
			if len(h.spsMsg) > 0 {
				g = append(g, h.spsMsg)
			}
			if len(h.ppsMsg) > 0 {
				g = append(g, h.ppsMsg)
			}
			g = append(g, msg)
			h.gopCache = g
		}
		// 实时广播当前 NAL
		for ws := range h.clients {
			if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				log.Printf("ws write error: %v", err)
				_ = ws.Close()
				delete(h.clients, ws)
			}
		}
	}
}

/* ----------------- Annex-B 解析工具 ----------------- */

// 返回：完整 NAL 消息（均包含起始码）列表 + 剩余半截
// 返回：完整 NAL 消息（均包含起始码）列表 + 剩余半截
func cutNALs(buf []byte) (msgs [][]byte, rest []byte) {
	findStart := func(from int) int {
		// 查 00 00 01 或 00 00 00 01
		idx3 := bytes.Index(buf[from:], []byte{0, 0, 1})
		idx4 := bytes.Index(buf[from:], []byte{0, 0, 0, 1})
		switch {
		case idx3 < 0 && idx4 < 0:
			return -1
		case idx3 < 0:
			return from + idx4
		case idx4 < 0:
			return from + idx3
		default:
			if from+idx3 < from+idx4 {
				return from + idx3
			}
			return from + idx4
		}
	}

	start := findStart(0)
	if start < 0 {
		// 没有起始码，整段保留为剩余
		return nil, buf
	}

	for {
		// 确定起始码长度
		scLen := 3
		if start+4 <= len(buf) && buf[start] == 0 && buf[start+1] == 0 && buf[start+2] == 0 && buf[start+3] == 1 {
			scLen = 4
		}
		// 找下一个起始码
		next := findStart(start + scLen)
		if next < 0 {
			// 剩余不足一个完整 NAL，留待下次
			rest = buf[start:]
			break
		}
		msgs = append(msgs, buf[start:next])
		start = next
		if start >= len(buf) {
			break
		}
	}
	return msgs, rest
}

// 读取 NAL 类型（去掉起始码后的第一个字节 & 0x1F）
func nalType(msg []byte) byte {
	// 跳过起始码
	i := 3
	if len(msg) >= 4 && msg[0] == 0 && msg[1] == 0 && msg[2] == 0 && msg[3] == 1 {
		i = 4
	}
	if len(msg) <= i {
		return 0
	}
	return msg[i] & 0x1F
}
