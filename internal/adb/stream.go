// internal/adb/stream.go
package adb

import (
	"context"
	"os"
	"os/exec"
	"io"
)

func StartScreenStream(ctx context.Context) (io.ReadCloser, *exec.Cmd, error) {
	// 注意：必须是 exec-out + 最后参数 "-"，这样 H264 才写到 STDOUT
	args := []string{
		"exec-out", "screenrecord",
		"--output-format=h264",
		"--size", "720x1280",       // 可调小一点更稳
		"--bit-rate", "2000000",    // 2Mbps
		"-",
	}
	cmd := exec.CommandContext(ctx, "adb", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil { return nil, nil, err }
	// 让我们能看到 device 的报错
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil { return nil, nil, err }
	return stdout, cmd, nil
}
