#!/bin/bash
# launchd 入口：固定 node 路径，避免 nvm 版本切换后找不到解释器。
export PATH="/Users/MacBook/.nvm/versions/node/v24.22.1/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /Users/MacBook/.nvm/versions/node/v24.22.1/bin/node \
  /Users/MacBook/localprojects/ai-toolbox/bin/ai-toolbox.mjs notes-daemon --quiet
