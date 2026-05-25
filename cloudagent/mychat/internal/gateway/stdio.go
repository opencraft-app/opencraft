package gateway

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"sync"
)

type AgentProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
	once   sync.Once
}

func StartAgent(ctx context.Context, command []string) (*AgentProcess, error) {
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &AgentProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

func (p *AgentProcess) WriteLine(data []byte) error {
	if _, err := p.stdin.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

func (p *AgentProcess) ReadStdoutLines(ctx context.Context, emit func([]byte)) error {
	scanner := bufio.NewScanner(p.stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) > 0 {
			emit(line)
		}
		select {
		case <-ctx.Done():
			return nil
		default:
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

func (p *AgentProcess) ReadStderrLines(ctx context.Context, emit func(string)) error {
	scanner := bufio.NewScanner(p.stderr)
	scanner.Buffer(make([]byte, 0, 16*1024), 512*1024)
	for scanner.Scan() {
		emit(scanner.Text())
		select {
		case <-ctx.Done():
			return nil
		default:
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

func (p *AgentProcess) Close() {
	p.once.Do(func() {
		_ = p.stdin.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		_ = p.cmd.Wait()
	})
}
