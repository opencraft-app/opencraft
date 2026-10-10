package instance

// renderDesktopInstallPackagesCommand isolates distribution-specific package names
// from the shared desktop units and CTL progress protocol. It runs inside the
// installer, which supplies say, fail and LOG; it must not install external repos.
func renderDesktopInstallPackagesCommand() string {
	return `install_desktop_packages(){
  local ID="" VERSION_ID=""
  [ -r /etc/os-release ] || fail "cannot read /etc/os-release"
  . /etc/os-release || fail "cannot load /etc/os-release"
  case "$ID" in
    ubuntu|debian)
      command -v apt-get >/dev/null 2>&1 || fail "apt-get unavailable"
      say 5 "apt update"
      sudo -n apt-get update -y >>"$LOG" 2>&1 || fail "apt update"
      say 30 "install desktop packages (apt)"
      sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y \
        xvfb x11vnc novnc websockify xfce4 xfce4-terminal dbus-x11 \
        fonts-wqy-zenhei fonts-noto-cjk curl >>"$LOG" 2>&1 || fail "apt install"
      ;;
    tencentos)
      [ "$VERSION_ID" = "4.4" ] || fail "unsupported TencentOS version: $VERSION_ID"
      command -v dnf >/dev/null 2>&1 || fail "dnf unavailable"
      say 5 "TencentOS 4.4 packages from configured repositories"
      say 30 "install desktop packages (dnf)"
      sudo -n dnf install -y \
        xorg-x11-server-Xvfb x11vnc novnc python3-websockify \
        xfce4-session xfce4-panel xfce4-settings xfce4-terminal \
        xfdesktop xfwm4 xfce4-appfinder xfce4-notifyd \
        dbus-daemon dbus-x11 google-noto-sans-cjk-sc-fonts curl \
        >>"$LOG" 2>&1 || fail "dnf install (check TencentOS BaseOS/AppStream/EPOL repositories)"
      ;;
    *) fail "unsupported desktop operating system: $ID $VERSION_ID" ;;
  esac
}
install_desktop_packages`
}
