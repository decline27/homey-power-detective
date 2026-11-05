#!/bin/sh
# Downloads the Homey's raw record (src/homey/recorder.ts) into <dir>, one YYYY-MM-DD.csv per day.
# Needs the homey CLI, logged in, with the Homey selected. Usage: test/bench/fetch-raw.sh [dir]
set -e
dir=${1:-bench-data/raw}
app=/api/app/com.decline27.powerdetective
mkdir -p "$dir"
# The CLI's output is cut short when piped: always go through a file.
homey api raw --path "$app/debug/raw" > "$dir/.days.json" 2>/dev/null
for date in $(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");for(const d of JSON.parse(t.slice(t.indexOf("["))))console.log(d.date)' "$dir/.days.json"); do
  homey api raw --path "$app/debug/raw/$date" > "$dir/.day.json" 2>/dev/null
  node -e '
    const fs = require("fs");
    const t = fs.readFileSync(process.argv[1], "utf8");
    const d = JSON.parse(t.slice(t.indexOf("{")));
    fs.writeFileSync(process.argv[2], require("zlib").gunzipSync(Buffer.from(d.gzip, "base64")));
  ' "$dir/.day.json" "$dir/$date.csv"
  echo "$date $(wc -l < "$dir/$date.csv") lines"
done
rm -f "$dir/.days.json" "$dir/.day.json"
