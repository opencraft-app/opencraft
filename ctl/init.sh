#!/bin/bash

curPath=`dirname $0`
cd $curPath
prjHome=`pwd`

envPath="$prjHome/tmp/rigger.env"
if [ -f $envPath ]
then
    source $envPath
fi

/usr/local/bin/rigger -rconfDir=$prjHome/conf/rigger/ prjHome=$prjHome
