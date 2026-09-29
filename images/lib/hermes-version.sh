#!/usr/bin/env bash

parse_hermes_cli_version() {
  LC_ALL=C awk '
    $0 ~ /^Hermes Agent v[0-9]+\.[0-9]+(\.[0-9]+)?([[:space:]]|$)/ {
      version = $3
      sub(/^v/, "", version)
      print version
      exit
    }
  '
}
