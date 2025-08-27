
(() => {
    const logEl = document.getElementById('log');
    const btn = document.getElementById('btn');
    const canvas = document.getElementById('cv');
    const ctx = canvas.getContext('2d');

    let ws, decoder, configured = false, gotKey = false;
    let sps = null, pps = null;
    let pending = new Uint8Array(0);
    let curAU = []; // 当前访问单元的 NAL 列表
    let frameNo = 0;

    const stat = { sps: 0, pps: 0, idr: 0, aud: 0, au: 0, dec: 0 };
    const log = (s) => logEl.textContent = s + ` | SPS:${stat.sps} PPS:${stat.pps} IDR:${stat.idr} AUD:${stat.aud} AU:${stat.au} DEC:${stat.dec}`;

    function fit(w, h) {
        const r = w / h, W = window.innerWidth, H = window.innerHeight - 44;
        let cw, ch; if (W / H > r) { ch = H; cw = Math.floor(H * r); } else { cw = W; ch = Math.floor(W / r); }
        canvas.width = cw; canvas.height = ch;
    }
    window.addEventListener('resize', () => { if (decoder && decoder.state === 'configured') fit(decoder._w, decoder._h); });

    // ---- Annex-B 切 NAL（支持跨包） ----
    function append(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
    function isStart(u8, i) {
        return (i + 3 <= u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) ||
            (i + 4 <= u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1);
    }
    function scSize(u8, i) { return (u8[i + 2] === 1) ? 3 : 4; }

    // 从 pending 中尽量切完整 NAL，返回 {units, rest}
    function cutNAL(u8) {
        const units = []; let i = 0;
        while (i + 3 <= u8.length && !isStart(u8, i)) i++;
        if (i + 3 > u8.length) return { units, rest: u8 };
        let start = i, sc = scSize(u8, start); i = start + sc;
        while (true) {
            let j = i; while (j + 3 <= u8.length && !isStart(u8, j)) j++;
            if (j + 3 > u8.length) { return { units, rest: u8.slice(start) }; }
            const ps = start + sc, pe = j;
            if (pe > ps) {
                const nal = u8.subarray(ps, pe);
                const t = nal[0] & 0x1F;
                units.push({ type: t, data: nal });
            }
            start = j; sc = scSize(u8, start); i = start + sc;
        }
    }

    // ---- AVCC/codec from SPS ----
    function buildAVCC(sps, pps) {
        const prof = sps[0], compat = sps[1], level = sps[2];
        const v = [0x01, prof, compat, level, 0xFF, 0xE1, (sps.length >> 8) & 0xFF, sps.length & 0xFF, ...sps, 0x01, (pps.length >> 8) & 0xFF, pps.length & 0xFF, ...pps];
        return new Uint8Array(v).buffer;
    }
    const hex = n => n.toString(16).padStart(2, '0');
    function codecFromSPS(sps) { return `avc1.${hex(sps[0])}00${hex(sps[2])}`; }

    function ensureConfig() {
        if (configured || !sps || !pps) return;
        const desc = buildAVCC(sps, pps), codec = codecFromSPS(sps);
        decoder = new VideoDecoder({
            output: f => {
                const w = f.displayWidth, h = f.displayHeight;
                if (!decoder._w) { decoder._w = w; decoder._h = h; fit(w, h); }
                ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
                f.close(); stat.dec++; log('decoding…');
            },
            error: e => log('decoder error: ' + e.message),
        });
        decoder.configure({ codec, hardwareAcceleration: 'prefer-hardware', description: desc });
        configured = true; log(`configured ${codec}，等待关键帧…`);
    }

    // 把一个完整 AU 送给解码器（必要时在关键帧前预置 SPS/PPS）
    function feedAU(units) {
        if (!units || units.length === 0) return;

        // 更新 SPS/PPS 计数
        for (const u of units) {
            if (u.type === 7) { sps = u.data; stat.sps++; }
            else if (u.type === 8) { pps = u.data; stat.pps++; }
        }
        if (!configured && sps && pps) ensureConfig();

        const isIDR = units.some(u => u.type === 5);
        if (isIDR) stat.idr++;
        if (!configured || (!gotKey && !isIDR)) return; // 没关键帧前不解码
        if (isIDR) { gotKey = true; }

        // 关键帧前确保带上参数集
        let finalUnits = units;
        if (isIDR) {
            // 若此 AU 内没有带 SPS/PPS，则前置一下
            const hasS = units.some(u => u.type === 7), hasP = units.some(u => u.type === 8);
            if (!hasS && sps) finalUnits = [{ type: 7, data: sps }, ...finalUnits];
            if (!hasP && pps) finalUnits = [{ type: 8, data: pps }, ...finalUnits];
        }

        // 合成 AVCC（一帧一个 EncodedVideoChunk）
        let total = 0; for (const u of finalUnits) total += 4 + u.data.length;
        const out = new Uint8Array(total); let off = 0;
        for (const u of finalUnits) {
            const n = u.data.length;
            out[off] = (n >>> 24) & 0xFF; out[off + 1] = (n >>> 16) & 0xFF; out[off + 2] = (n >>> 8) & 0xFF; out[off + 3] = n & 0xFF;
            out.set(u.data, off + 4); off += 4 + n;
        }
        const chunk = new EncodedVideoChunk({
            type: isIDR ? 'key' : 'delta',
            timestamp: (frameNo++) * 33333,
            data: out
        });
        decoder.decode(chunk);
    }

    // 处理切出的 NAL：按 AUD 分帧
    function onNAL(units) {
        for (const u of units) {
            if (u.type === 9) { // AUD：一帧结束
                if (curAU.length) {
                    stat.au++; feedAU(curAU);
                    curAU = [];
                }
                stat.aud++; // 新 AU 开始（AUD 自身留在开头也行）
                curAU.push(u);
            } else {
                curAU.push(u);
            }
        }
    }

    // WS
    btn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); return; }
        ws = new WebSocket(`ws://${location.host}/ws`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => log('WS 连接成功，等待流…');
        ws.onclose = () => log('WS 已关闭');
        ws.onerror = () => log('WS 错误');
        ws.onmessage = ev => {
            if (typeof ev.data === 'string') return;
            pending = append(pending, new Uint8Array(ev.data));
            const { units, rest } = cutNAL(pending);
            pending = rest;
            if (units.length) onNAL(units);
        };
    };
})();

