package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"path/filepath"
	"time"

	workspacev2 "hypernode/internal/workspaces"
)

type workspaceV2Options struct {
	ImagePath      string
	ImageSizeBytes int64
	MountPath      string
	ContainerImage string
	DockerfilePath string
	DockerBinary   string
	RuncBinary     string
	RuntimeRoot    string
	UIDBase        int
	UsersRoot      string
	AgentBinary    string
	AgentPolicy    string
	WithRuntime    bool
}

type workspaceV2Stack struct {
	Volume  workspacev2.VolumeConfig
	Driver  *workspacev2.LocalBtrfsDriver
	Manager *workspacev2.Manager
	Runtime *workspacev2.RuncRuntime
}

func (s *workspaceV2Stack) Close() error {
	if s == nil || s.Runtime == nil {
		return nil
	}
	return s.Runtime.Close()
}

func absolutePath(value string) (string, error) {
	path, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	return filepath.Clean(path), nil
}

func newWorkspaceV2Stack(options workspaceV2Options) (*workspaceV2Stack, error) {
	imagePath, err := absolutePath(options.ImagePath)
	if err != nil {
		return nil, err
	}
	mountPath, err := absolutePath(options.MountPath)
	if err != nil {
		return nil, err
	}
	usersRoot, err := absolutePath(options.UsersRoot)
	if err != nil {
		return nil, err
	}
	volume := workspacev2.VolumeConfig{ImagePath: imagePath, SizeBytes: options.ImageSizeBytes, MountPath: mountPath}
	var runtime workspacev2.LocalRuntime
	var runcRuntime *workspacev2.RuncRuntime
	var runtimeErr error
	if options.WithRuntime {
		runtimeRoot := options.RuntimeRoot
		if runtimeRoot == "" {
			runtimeRoot = "/run/hypernode-workspaces"
		}
		runtimeRoot, err = absolutePath(runtimeRoot)
		if err != nil {
			return nil, err
		}
		resolver, resolverErr := workspacev2.PrincipalAttachmentResolver(usersRoot)
		if resolverErr != nil {
			return nil, resolverErr
		}
		homeResolver, resolverErr := workspacev2.PrincipalHomeResolver(usersRoot)
		if resolverErr != nil {
			return nil, resolverErr
		}
		runcRuntime, runtimeErr = workspacev2.NewRuncRuntime(workspacev2.RuncRuntimeConfig{
			RuntimeRoot: runtimeRoot,
			RuncBinary:  options.RuncBinary, AgentBinary: options.AgentBinary, AgentPolicy: options.AgentPolicy,
			UIDBase: options.UIDBase, AttachmentSourceResolver: resolver,
			PrincipalHomeResolver: homeResolver,
		})
		if runtimeErr != nil {
			return nil, runtimeErr
		}
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if err := runcRuntime.ReconcileRuntimeRoot(cleanupContext); err != nil {
			_ = runcRuntime.Close()
			return nil, err
		}
		runtime = runcRuntime
	}
	driver, err := workspacev2.NewLocalBtrfsDriver(workspacev2.LocalBtrfsConfig{
		MountPath: mountPath, TemplateName: "ubuntu-24.04", ContainerImage: options.ContainerImage,
		DockerfilePath: options.DockerfilePath, DockerBinary: options.DockerBinary,
		OwnerUIDBase: options.UIDBase, Runtime: runtime,
	})
	if err != nil {
		if runcRuntime != nil {
			_ = runcRuntime.Close()
		}
		return nil, err
	}
	catalog, err := workspacev2.OpenCatalog(filepath.Join(mountPath, ".workspaces", "catalog.json"))
	if err != nil {
		return nil, err
	}
	manager, err := workspacev2.NewManager(catalog, driver)
	if err != nil {
		if runcRuntime != nil {
			_ = runcRuntime.Close()
		}
		return nil, err
	}
	return &workspaceV2Stack{Volume: volume, Driver: driver, Manager: manager, Runtime: runcRuntime}, nil
}

func workspaceV2Command(action string, args []string) error {
	flags := flag.NewFlagSet("workspace "+action, flag.ContinueOnError)
	imagePath := flags.String("image", "/data/data.img", "sparse Btrfs workspace image")
	imageSizeTB := flags.Int64("image-size-tb", 16, "logical sparse image size in decimal TB")
	mountPath := flags.String("mount", "/data/hypernode/.runtime/workspace", "host Btrfs mountpoint")
	dockerExecutable := flags.String("docker-bin", "docker", "Docker client executable")
	containerImage := flags.String("container-image", "hypernode/workspace:ubuntu-24.04", "workspace template image")
	dockerfile := flags.String("dockerfile", "deploy/workspace/Dockerfile", "workspace Dockerfile")
	usersRoot := flags.String("users-root", "/data/hypernode/.runtime/users", "per-user state root")
	uidBase := flags.Int("workspace-uid-base", 100000, "host UID/GID base for the workspace user namespace")
	buildImage := flags.Bool("build", action == "prepare-v2", "build the clean Ubuntu template image")
	if err := flags.Parse(args); err != nil {
		return err
	}
	stack, err := newWorkspaceV2Stack(workspaceV2Options{
		ImagePath: *imagePath, ImageSizeBytes: *imageSizeTB * 1_000_000_000_000,
		MountPath: *mountPath, ContainerImage: *containerImage, DockerfilePath: *dockerfile,
		DockerBinary: *dockerExecutable, UIDBase: *uidBase, UsersRoot: *usersRoot,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	switch action {
	case "prepare-v2":
		if err := workspacev2.PrepareVolume(ctx, stack.Volume); err != nil {
			return err
		}
		if err := stack.Driver.PrepareTemplate(ctx, *buildImage); err != nil {
			return err
		}
	case "status-v2":
		// Read-only below.
	}
	return printWorkspaceV2Status(ctx, stack)
}

func printWorkspaceV2Status(ctx context.Context, stack *workspaceV2Stack) error {
	volume, err := workspacev2.InspectVolume(ctx, stack.Volume)
	if err != nil {
		return err
	}
	snapshot := stack.Manager.Snapshot()
	value := map[string]any{
		"volume": volume, "templatePrepared": stack.Driver.TemplatePrepared(ctx),
		"driver": workspacev2.LocalBtrfsDriverName, "root": snapshot.Root,
		"threadCount": len(snapshot.Threads), "workspaceCount": len(snapshot.Workspaces),
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}
