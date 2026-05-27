# Ubuntu Plucky Cloud Image URLs

- amd64: https://cloud-images.ubuntu.com/releases/plucky/release/ubuntu-25.04-server-cloudimg-amd64-root.tar.xz
- arm64: https://cloud-images.ubuntu.com/releases/plucky/release/ubuntu-25.04-server-cloudimg-arm64-root.tar.xz

Default local layout after `./hack/buildloop.sh`:

- tarballs: `assets/rootfs/downloads/rootfs-amd64.tar.xz`
- tarballs: `assets/rootfs/downloads/rootfs-arm64.tar.xz`
- built images: `assets/rootfs/images/plucky-<arch>.img`

Source:
- https://cloud-images.ubuntu.com/releases/plucky/release/
