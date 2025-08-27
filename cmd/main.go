package main

import (
	"context"
	"embed"
	"io"
	"io/fs"
	"log"
	"time"

	"alan3344/go-h264-cast/internal/adb"
	"alan3344/go-h264-cast/internal/server"
	"alan3344/go-h264-cast/internal/types"
)

//go:embed web/*
var webFS embed.FS

func main() {
	ctx := context.Background()

	// 0) ADB 检查
	if err := adb.CheckADB(ctx); err != nil {
		log.Fatalf("ADB 不可用：%v", err)
	}

	// 1) 等设备（忽略失败，继续）
	_ = adb.WaitDevice(ctx, 8*time.Second)
	devs, _ := adb.DeviceList(ctx)
	if len(devs) == 0 {
		log.Fatal("未发现在线设备，请先 USB/无线连接手机（adb devices）")
	}
	log.Printf("发现设备：%v", devs)

	// 2) 起 HTTP+WS
	hub := server.NewHub()
	go func() {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			log.Fatalf("读取 embed 文件子目录失败：%v", err)
		}
		if err := hub.Serve(types.DefaultHTTPAddr, sub, types.WSPath); err != nil {
			log.Fatalf("HTTP 服务退出：%v", err)
		}
	}()
	log.Printf("打开: http://localhost%s", types.DefaultHTTPAddr)

	// 3) 拉取 H264 裸流并广播
	for {
		stdout, cmd, err := adb.StartScreenStream(ctx)
		if err != nil {
			log.Fatalf("启动 screenrecord 失败：%v", err)
		}
		defer func() { _ = cmd.Process.Kill() }()

		buf := make([]byte, 64*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				hub.Broadcast(buf[:n])
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("读取错误：%v", err)
				}
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// go build -o bin\cmd_ws.exe .\cmd\main.go