#!/bin/bash
# Stop only what up.sh started (own process groups + own tmux socket).
S=/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2wui
export PATH=/home/harry/.local/share/omo/bin:/home/harry/.npm/_npx/361c55be1121897e/node_modules/.bin:$PATH
for f in server chrome; do [ -f $S/$f.pid ] && kill -TERM -- -$(cat $S/$f.pid) 2>/dev/null; rm -f $S/$f.pid; done
tmux -L omo-t2-worldui kill-server 2>/dev/null
sleep 1; ss -ltnp 2>/dev/null | grep -E ':(352[0-9]|353[0-9]) ' || echo "lane ports free"
