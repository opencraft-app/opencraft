# Managed noninteractive bash entry. Login profiles may reset PATH after exec env.
if [ -n "${OPENCRAFT_GIT_PREVIOUS_BASH_ENV:-}" ] && [ "$OPENCRAFT_GIT_PREVIOUS_BASH_ENV" != "${BASH_ENV:-}" ]; then
  . "$OPENCRAFT_GIT_PREVIOUS_BASH_ENV"
fi
if [ -n "${OPENCRAFT_GIT_BIN:-}" ]; then
  case "${PATH:-}" in
    "${OPENCRAFT_GIT_BIN}"|"${OPENCRAFT_GIT_BIN}:"*) ;;
    *) PATH="${OPENCRAFT_GIT_BIN}:${PATH:-/usr/bin:/bin}"; export PATH ;;
  esac
fi
