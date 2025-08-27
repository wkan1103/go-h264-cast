(() => {
    const logEl = document.getElementById('log');
    const btn = document.getElementById('btn');
    const player = document.getElementById('player');

    const log = (s) => logEl.textContent = s + ` | ${stats()}`;
    const stat = { sps: 0, pps: 0, idr: 0, aud: 0, au: 0, feed: 0 };
    const stats = () => `SPS:${stat.sps} PPS:${stat.pps} IDR:${stat.idr} AUD:${stat.aud} AU:${stat.au} FEED:${stat.feed}`;

    // --- JMuxer ---
    const jmx = new JMuxer({
        node: 'player',            // 绑定 <video id="player">
        mode: 'video',
        fps: 30,                   // 和实际帧率接近即可
        debug: false,
        // flushingTime: 0          // 需要更低延时可调
    });

    // --- Annex-B 解析 ---
    let ws, pending = new Uint8Array(0), curAU = [], sps = null, pps = null, frameNo = 0;

    const append = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
    const isStart = (u8, i) =>
        (i + 3 < u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) ||
        (i + 4 < u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1);
    const scSize = (u8, i) => (u8[i + 2] === 1 ? 3 : 4);

    // 切 NAL（可跨包）
    function cutNAL(u8) {
        const units = []; let i = 0;
        while (i + 3 <= u8.length && !isStart(u8, i)) i++;
        if (i + 3 > u8.length) return { units, rest: u8 };
        let start = i, sc = scSize(u8, start); i = start + sc;
        while (true) {
            let j = i; while (j + 3 <= u8.length && !isStart(u8, j)) j++;
            if (j + 3 > u8.length) return { units, rest: u8.slice(start) };
            const ps = start + sc, pe = j;
            if (pe > ps) {
                const nal = u8.subarray(ps, pe); const t = nal[0] & 0x1F;
                units.push({ type: t, data: nal });
            }
            start = j; sc = scSize(u8, start); i = start + sc;
        }
    }

    // 输出一帧给 JMuxer（fMP4）
    function feedAU(units) {
        if (!units.length) return;

        // 记录 SPS/PPS
        for (const u of units) {
            if (u.type === 7) { sps = u.data; stat.sps++; }
            else if (u.type === 8) { pps = u.data; stat.pps++; }
        }
        const isIDR = units.some(u => u.type === 5);
        if (isIDR) stat.idr++;

        // 关键帧前确保有 SPS/PPS
        if (isIDR) {
            const hasS = units.some(u => u.type === 7);
            const hasP = units.some(u => u.type === 8);
            if (!hasS && sps) units = [{ type: 7, data: sps }, ...units];
            if (!hasP && pps) units = [{ type: 8, data: pps }, ...units];
        }

        // 组合成 Annex-B（起始码）并投喂 JMuxer
        let bytes = 0; for (const u of units) bytes += 4 + u.data.length;
        const frame = new Uint8Array(bytes); let p = 0;
        for (const u of units) { frame.set([0, 0, 0, 1], p); p += 4; frame.set(u.data, p); p += u.data.length; }

        jmx.feed({
            video: frame,
            // JMuxer 接受毫秒时间戳；简单用递增即可
            timestamp: Math.floor((frameNo++) * (1000 / 30))
        });

        stat.feed++; log('feeding…');
    }

    // 按 AUD 或切片边界分帧
    function onNAL(units) {
        for (const u of units) {
            if (u.type === 9) { // AUD：上一个 AU 结束
                if (curAU.length) { stat.au++; feedAU(curAU); curAU = []; }
                stat.aud++; curAU.push(u); // 保留 AUD 作为起始
            } else if ((u.type === 1 || u.type === 5) && curAU.some(x => x.type === 1 || x.type === 5)) {
                stat.au++; feedAU(curAU); curAU = [u];
            } else {
                curAU.push(u);
            }
        }
    }

    const MAX_PENDING = 2 * 1024 * 1024;  // 上限窗口
    function clampPendingSafe(u8) {
        if (u8.length <= MAX_PENDING) return u8;

        // 从尾部往前回溯一个窗口，找“起始码”对齐点
        const start = Math.max(0, u8.length - MAX_PENDING);
        let i = start;
        const len = u8.length;
        const isSC = (k) =>
            (k + 3 <= len && u8[k] === 0 && u8[k + 1] === 0 && u8[k + 2] === 1) ||
            (k + 4 <= len && u8[k] === 0 && u8[k + 1] === 0 && u8[k + 2] === 0 && u8[k + 3] === 1);

        // 向前找第一个起始码（尽量对齐到 NAL 边界）
        while (i < len && !isSC(i)) i++;

        if (i < len) {
            // ⚠️ 重新同步：丢弃未完成 AU，等下一个 IDR
            curAU = [];
            gotKey = false;
            return u8.subarray(i);
        } else {
            // 实在没找到起始码：保留末尾极少字节，等待下一包补齐
            curAU = [];
            gotKey = false;
            return u8.subarray(len - 4);
        }
    }

    // WS
    btn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); return; }
        ws = new WebSocket(`ws://${location.host}/ws`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => log('WS 连接成功，等待流…');
        ws.onerror = () => log('WS 错误');
        ws.onclose = () => { log('WS 已关闭'); pending = new Uint8Array(0); curAU = []; frameNo = 0; };
        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') return;
            const chunk = new Uint8Array(ev.data);
            console.log('recv', chunk.byteLength);
            pending = append(pending, chunk);

            // 仅使用“安全裁切”
            pending = clampPendingSafe(pending);

            const { units, rest } = cutNAL(pending);
            pending = rest;
            if (units.length) onNAL(units);
        };
    };

    // 自动连一次
    btn.click();
})();
