# Find Yasno's address endpoints in its web app bundles.
set +e
for page in https://yasno.ua/ https://yasno.ua/planovi-vidkliuchennia https://app.yasno.ua/; do
  curl -sSL -m 30 -A "Mozilla/5.0" "$page" -o page.html -w "$page %{http_code} %{size_download}\n"
  grep -oE '(src|href)="[^"]+\.js[^"]*"' page.html | sed -E 's/^(src|href)="//; s/"$//' | sort -u > js.txt
  while read -r js; do
    case "$js" in http*) url="$js";; //*) url="https:$js";; /*) url="$(echo $page | grep -oE 'https://[^/]+')$js";; *) url="$page$js";; esac
    curl -sSL -m 30 "$url" -o b.js
    grep -oE '"[^"]{0,80}(addresses|streets|houses|group)[^"]{0,120}"|`[^`]{0,80}(addresses|streets|houses)[^`]{0,160}`' b.js | sort -u | head -30 | sed "s|^|$(basename $url | cut -c1-30): |"
  done < js.txt
done
