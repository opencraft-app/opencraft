#!/bin/bash

if [ $# -lt 1 ]
then
    echo "Usage $0 target [linux]"
    exit 1
fi

target=$1

if [ $# -eq 2 ]
then
    if [ ! $2 = "linux" ]
    then
        echo "Usage: $0 target [linux]"
        exit 1
    fi

    export CGO_ENABLED=0
    export GOOS=linux
    export GOARCH=amd64
fi

curDir=`dirname $0`
cd $curDir/../
prjHome=`pwd`


source $prjHome/tools/version.sh
LDFLAGS="-X 'lightglobal/pkg/version.version=${VERSION}'"

go build -ldflags="${LDFLAGS}" -o $prjHome/bin/$target ./main/$target/*
