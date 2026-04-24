#!/bin/bash

export TZ=Asia/Shanghai

commitAuthor=`git log -n 1 --format=%an`
commitTime=`git log -n 1 --format=%cd --date=format-local:%Y%m%d%H%M%S`
commitHash=`git log -n 1 --format=%H | head -c 12`


export VERSION="${commitAuthor}-${commitTime}-${commitHash}"