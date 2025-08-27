package adb

import (
	"bufio"
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

func CheckADB(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "adb", "version")
	if err := cmd.Run(); err != nil {
		return errors.New("未找到 adb（请安装并加入 PATH）")
	}
	return nil
}

func WaitDevice(ctx context.Context, timeout time.Duration) error {
	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(tctx, "adb", "wait-for-any-device")
	return cmd.Run()
}

func DeviceList(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, "adb", "devices").CombinedOutput()
	if err != nil {
		return nil, err
	}
	var ids []string
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasSuffix(line, "\tdevice") {
			ids = append(ids, strings.Split(line, "\t")[0])
		}
	}
	return ids, nil
}

// func StartScreenStream(ctx context.Context) (io.ReadCloser, *exec.Cmd, error) {
// 	cmd := exec.CommandContext(ctx,
// 		"adb", "exec-out",
// 		"screenrecord",
// 		// "--size", "720x1280",
// 		"--size", "1280x720",
// 		// "--bit-rate", "2000000 ",
// 		"--bit-rate", "4000000 ",
// 		"--output-format=h264",
// 		"-",
// 	)
// 	stdout, err := cmd.StdoutPipe()
// 	if err != nil {
// 		return nil, nil, err
// 	}
// 	stderr, _ := cmd.StderrPipe()
// 	if err = cmd.Start(); err != nil {
// 		return nil, nil, err
// 	}
// 	// 打印 screenrecord 的错误信息
// 	go func() {
// 		sc := bufio.NewScanner(stderr)
// 		for sc.Scan() {
// 			log.Printf("[screenrecord] %s", sc.Text())
// 		}
// 	}()
// 	return stdout, cmd, nil
// }
