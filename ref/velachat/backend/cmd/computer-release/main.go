// Command computer-release 构建、签名并可选发布不可变 Computer 制品。
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	cosadapter "chatserver/internal/adapters/tencent/cos"
	"chatserver/internal/computerrelease"
	"chatserver/internal/securefile"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) > 0 && args[0] == "keygen" {
		return runKeygen(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "verify" {
		return runVerify(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "build-set" {
		return runBuildSet(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "verify-set" {
		return runVerifySet(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "publish-set" {
		return runPublishSet(
			ctx, args[1:], os.Stdout,
			func(config cosadapter.Config) (computerrelease.ObjectPublisher, error) {
				return cosadapter.NewPublisher(config)
			},
		)
	}
	if len(args) > 0 && args[0] == "publish" {
		return runPublish(
			ctx,
			args[1:],
			os.Stdout,
			func(config cosadapter.Config) (computerrelease.ObjectPublisher, error) {
				return cosadapter.NewPublisher(config)
			},
		)
	}
	flags := flag.NewFlagSet("computer-release", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var (
		version, target, osType, architecture, keyID                   string
		privateKeyFile, programPath, installerPath, outputDirectory    string
		bucket, region, secretIDFile, secretKeyFile, securityTokenFile string
		publish                                                        bool
	)
	flags.StringVar(&version, "version", "", "不可变发布版本")
	flags.StringVar(&target, "target", "darwin-arm64", "发布 target")
	flags.StringVar(&osType, "os-type", "macos", "产品操作系统")
	flags.StringVar(&architecture, "architecture", "arm64", "CPU 架构")
	flags.StringVar(&keyID, "signing-key-id", "", "Ed25519 签名密钥 ID")
	flags.StringVar(&privateKeyFile, "private-key-file", "", "0600 Ed25519 私钥文件")
	flags.StringVar(&programPath, "program", "", "vela-computer 绝对路径")
	flags.StringVar(&installerPath, "installer", "", "install.sh 绝对路径")
	flags.StringVar(&outputDirectory, "output", "", "新发布目录绝对路径")
	flags.BoolVar(&publish, "publish", false, "构建后上传私有 COS")
	flags.StringVar(&bucket, "bucket", "", "COS 私有制品桶")
	flags.StringVar(&region, "region", "", "COS 地域")
	flags.StringVar(&secretIDFile, "secret-id-file", "", "COS SecretId 文件")
	flags.StringVar(&secretKeyFile, "secret-key-file", "", "COS SecretKey 文件")
	flags.StringVar(&securityTokenFile, "security-token-file", "", "COS STS Token 文件（可选）")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("computer-release 参数无效")
	}
	privateKeyBytes, err := securefile.Read(privateKeyFile, "Computer release Ed25519 私钥", 4096)
	if err != nil {
		return err
	}
	privateKey, err := decodePrivateKey(privateKeyBytes)
	wipe(privateKeyBytes)
	if err != nil {
		return err
	}
	defer wipe(privateKey)
	bundle, err := computerrelease.Build(computerrelease.BuildConfig{
		Version: strings.TrimSpace(version), Target: strings.TrimSpace(target),
		OSType: strings.TrimSpace(osType), Architecture: strings.TrimSpace(architecture),
		SigningKeyID: strings.TrimSpace(keyID), PrivateKey: privateKey,
		ProgramPath: programPath, InstallerPath: installerPath,
		OutputDirectory: outputDirectory,
	})
	if err != nil {
		return err
	}
	if publish {
		secretID, err := readTextSecret(secretIDFile, "COS SecretId")
		if err != nil {
			return err
		}
		secretKey, err := readTextSecret(secretKeyFile, "COS SecretKey")
		if err != nil {
			return err
		}
		securityToken := ""
		if securityTokenFile != "" {
			securityToken, err = readTextSecret(securityTokenFile, "COS STS Token")
			if err != nil {
				return err
			}
		}
		publisher, err := cosadapter.NewPublisher(cosadapter.Config{
			Bucket: bucket, Region: region, SecretID: secretID,
			SecretKey: secretKey, SecurityToken: securityToken,
		})
		if err != nil {
			return err
		}
		if err := computerrelease.Publish(ctx, publisher, bundle); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintln(os.Stdout, bundle.CatalogPath)
	return err
}

func runBuildSet(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("computer-release build-set", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var version, keyID, privateKeyFile, macProgram, linuxProgram, output string
	flags.StringVar(&version, "version", "", "不可变发布版本")
	flags.StringVar(&keyID, "signing-key-id", "", "Ed25519 签名密钥 ID")
	flags.StringVar(&privateKeyFile, "private-key-file", "", "0600 Ed25519 私钥文件")
	flags.StringVar(&macProgram, "macos-program", "", "macOS ARM64 vela-computer")
	flags.StringVar(&linuxProgram, "linux-program", "", "Linux AMD64 vela-computer")
	flags.StringVar(&output, "output", "", "新发布目录绝对路径")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || stdout == nil {
		return errors.New("computer-release build-set 参数无效")
	}
	privateKeyBytes, err := securefile.Read(privateKeyFile, "Computer release Ed25519 私钥", 4096)
	if err != nil {
		return err
	}
	privateKey, err := decodePrivateKey(privateKeyBytes)
	wipe(privateKeyBytes)
	if err != nil {
		return err
	}
	defer wipe(privateKey)
	bundle, err := computerrelease.BuildReleaseSet(computerrelease.ReleaseSetBuildConfig{
		Version: strings.TrimSpace(version), SigningKeyID: strings.TrimSpace(keyID),
		PrivateKey: privateKey, OutputDirectory: output,
		Targets: []computerrelease.ReleaseTargetBuildConfig{
			{Target: "darwin-arm64", OSType: "macos", Architecture: "arm64", ProgramPath: macProgram},
			{Target: "linux-amd64", OSType: "linux", Architecture: "amd64", ProgramPath: linuxProgram},
		},
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, bundle.CatalogPath)
	return err
}

func runVerifySet(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("computer-release verify-set", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var releaseDirectory, publicKeyFile string
	flags.StringVar(&releaseDirectory, "release-directory", "", "待验证 Release Set 目录")
	flags.StringVar(&publicKeyFile, "public-key-file", "", "Ed25519 公钥文件")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || stdout == nil {
		return errors.New("computer-release verify-set 参数无效")
	}
	releaseSet, err := computerrelease.VerifyReleaseSetBundle(computerrelease.BundleVerificationConfig{
		Directory: releaseDirectory, PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "version=%s\ntargets=%d\n", releaseSet.Version, len(releaseSet.Releases))
	return err
}

func runPublishSet(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	newPublisher publisherFactory,
) error {
	flags := flag.NewFlagSet("computer-release publish-set", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var releaseDirectory, publicKeyFile, bucket, region, secretIDFile, secretKeyFile, tokenFile string
	flags.StringVar(&releaseDirectory, "release-directory", "", "已验签 Release Set 目录")
	flags.StringVar(&publicKeyFile, "public-key-file", "", "Ed25519 公钥文件")
	flags.StringVar(&bucket, "bucket", "", "COS 私有制品桶")
	flags.StringVar(&region, "region", "", "COS 地域")
	flags.StringVar(&secretIDFile, "secret-id-file", "", "COS SecretId 文件")
	flags.StringVar(&secretKeyFile, "secret-key-file", "", "COS SecretKey 文件")
	flags.StringVar(&tokenFile, "security-token-file", "", "COS STS Token 文件（可选）")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || ctx == nil ||
		stdout == nil || newPublisher == nil {
		return errors.New("computer-release publish-set 参数无效")
	}
	bundle, err := computerrelease.OpenVerifiedReleaseSet(computerrelease.BundleVerificationConfig{
		Directory: releaseDirectory, PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		return err
	}
	secretID, err := readTextSecret(secretIDFile, "COS SecretId")
	if err != nil {
		return err
	}
	secretKey, err := readTextSecret(secretKeyFile, "COS SecretKey")
	if err != nil {
		return err
	}
	securityToken := ""
	if strings.TrimSpace(tokenFile) != "" {
		securityToken, err = readTextSecret(tokenFile, "COS STS Token")
		if err != nil {
			return err
		}
	}
	publisher, err := newPublisher(cosadapter.Config{
		Bucket: bucket, Region: region, SecretID: secretID,
		SecretKey: secretKey, SecurityToken: securityToken,
	})
	if err != nil {
		return err
	}
	if err := computerrelease.PublishReleaseSet(ctx, publisher, bundle); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "published version=%s targets=%d\n", bundle.ReleaseSet.Version, len(bundle.Bundles))
	return err
}

type publisherFactory func(cosadapter.Config) (computerrelease.ObjectPublisher, error)

func runPublish(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	newPublisher publisherFactory,
) error {
	flags := flag.NewFlagSet("computer-release publish", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var (
		releaseDirectory, publicKeyFile                        string
		bucket, region, secretIDFile, secretKeyFile, tokenFile string
	)
	flags.StringVar(&releaseDirectory, "release-directory", "", "已验签发布目录")
	flags.StringVar(&publicKeyFile, "public-key-file", "", "Ed25519 公钥文件")
	flags.StringVar(&bucket, "bucket", "", "COS 私有制品桶")
	flags.StringVar(&region, "region", "", "COS 地域")
	flags.StringVar(&secretIDFile, "secret-id-file", "", "COS SecretId 文件")
	flags.StringVar(&secretKeyFile, "secret-key-file", "", "COS SecretKey 文件")
	flags.StringVar(&tokenFile, "security-token-file", "", "COS STS Token 文件（可选）")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || ctx == nil ||
		stdout == nil || newPublisher == nil {
		return errors.New("computer-release publish 参数无效")
	}
	bundle, err := computerrelease.OpenVerifiedBundle(computerrelease.BundleVerificationConfig{
		Directory: releaseDirectory, PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		return err
	}
	secretID, err := readTextSecret(secretIDFile, "COS SecretId")
	if err != nil {
		return err
	}
	secretKey, err := readTextSecret(secretKeyFile, "COS SecretKey")
	if err != nil {
		return err
	}
	securityToken := ""
	if strings.TrimSpace(tokenFile) != "" {
		securityToken, err = readTextSecret(tokenFile, "COS STS Token")
		if err != nil {
			return err
		}
	}
	publisher, err := newPublisher(cosadapter.Config{
		Bucket: bucket, Region: region, SecretID: secretID,
		SecretKey: secretKey, SecurityToken: securityToken,
	})
	if err != nil {
		return err
	}
	if err := computerrelease.Publish(ctx, publisher, bundle); err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		stdout,
		"published version=%s target=%s signingKeyId=%s\n",
		bundle.Release.Version,
		bundle.Release.Target,
		bundle.Release.SigningKeyID,
	)
	return err
}

func runKeygen(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("computer-release keygen", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var keyID, privateKeyFile, publicKeyFile string
	flags.StringVar(&keyID, "key-id", "", "不可变签名密钥 ID")
	flags.StringVar(&privateKeyFile, "private-key-file", "", "新建 0600 Ed25519 私钥文件")
	flags.StringVar(&publicKeyFile, "public-key-file", "", "新建 0644 Ed25519 公钥文件")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || stdout == nil {
		return errors.New("computer-release keygen 参数无效")
	}
	result, err := computerrelease.GenerateSigningKey(computerrelease.SigningKeyConfig{
		KeyID: strings.TrimSpace(keyID), PrivateKeyFile: privateKeyFile,
		PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		stdout,
		"keyId=%s\nprivateKeyFile=%s\npublicKeyFile=%s\npublicKeySHA256=%s\n",
		result.KeyID,
		result.PrivateKeyFile,
		result.PublicKeyFile,
		hex.EncodeToString(result.PublicKeySHA256[:]),
	)
	return err
}

func runVerify(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("computer-release verify", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var releaseDirectory, publicKeyFile string
	flags.StringVar(&releaseDirectory, "release-directory", "", "待验证发布目录")
	flags.StringVar(&publicKeyFile, "public-key-file", "", "Ed25519 公钥文件")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || stdout == nil {
		return errors.New("computer-release verify 参数无效")
	}
	release, err := computerrelease.VerifyBundle(computerrelease.BundleVerificationConfig{
		Directory: releaseDirectory, PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		stdout,
		"version=%s\ntarget=%s\nsigningKeyId=%s\nprogramSHA256=%s\n",
		release.Version,
		release.Target,
		release.SigningKeyID,
		hex.EncodeToString(release.Program.SHA256[:]),
	)
	return err
}

func decodePrivateKey(content []byte) (ed25519.PrivateKey, error) {
	encoded := strings.TrimSpace(string(content))
	for _, encoding := range []*base64.Encoding{
		base64.RawStdEncoding.Strict(), base64.StdEncoding.Strict(),
		base64.RawURLEncoding.Strict(), base64.URLEncoding.Strict(),
	} {
		decoded, err := encoding.DecodeString(encoded)
		if err == nil && len(decoded) == ed25519.PrivateKeySize {
			return ed25519.PrivateKey(decoded), nil
		}
		wipe(decoded)
	}
	return nil, errors.New("Computer release Ed25519 私钥无效")
}

func readTextSecret(filename string, label string) (string, error) {
	content, err := securefile.Read(filename, label, 4096)
	if err != nil {
		return "", err
	}
	defer wipe(content)
	value := strings.TrimSpace(string(content))
	if value == "" || len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New(label + "无效")
	}
	return value, nil
}

func wipe(content []byte) {
	for index := range content {
		content[index] = 0
	}
}
