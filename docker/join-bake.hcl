variable "OPENCRAFT_UID" { default = "1000" }
variable "OPENCRAFT_GID" { default = "1000" }

variable "JOIN_SOURCE" { default = "." }
variable "JOIN_BROWSER" { default = "" }
variable "JOIN_REVISION" { default = "" }

group "default" {
  targets = ["roles", "full"]
}

target "runtime-base" {
  context = "."
  dockerfile = "docker/Dockerfile.runtime-base"
  target = "runtime-base"
  platforms = ["linux/amd64"]
}

target "_common" {
  context = JOIN_SOURCE
  dockerfile = "docker/Dockerfile.owned-electron"
  platforms = ["linux/amd64"]
  args = {
    RUNTIME_IMAGE = "join-runtime"
    OPENCRAFT_UID = OPENCRAFT_UID
    OPENCRAFT_GID = OPENCRAFT_GID
    OPENCRAFT_SOURCE_REVISION = JOIN_REVISION
    OPENCRAFT_BUILD_ID = "git-${JOIN_REVISION}-join-ci"
    OPENCRAFT_CONTAINER_WEB_SCRIPT = "join:build:web"
    OPENCRAFT_GIT_HOSTS = "git.woa.com,github.com"
    OPENCRAFT_CONTAINER_GATEWAY_ENTRY = "products/join/gateway.mjs"
    OPENCRAFT_CONTAINER_GATEWAY_BUILD_SCRIPT = "products/join/build-gateway.mjs"
    OPENCRAFT_CONTAINER_HANDS_ENTRY = "products/join/hands.mjs"
  }
  labels = {
    "app.opencraft.distribution" = "join"
    "org.opencontainers.image.title" = "JoinVela"
    "org.opencontainers.image.source" = "https://git.woa.com/join/opencraft"
  }
}

target "roles" {
  inherits = ["_common"]
  matrix = { role = ["gateway", "brain", "hands", "proxy"] }
  name = role
  target = role
  tags = ["opencraft-join:${role}-${JOIN_REVISION}"]
  contexts = role == "hands" ? {
    join-runtime = "target:runtime-base"
    owned-electron = JOIN_BROWSER
  } : { join-runtime = "target:runtime-base" }
}

target "full" {
  inherits = ["_common"]
  target = "full"
  tags = ["opencraft-join:full-${JOIN_REVISION}"]
  contexts = {
    join-runtime = "target:runtime-base"
    owned-electron = JOIN_BROWSER
  }
}
