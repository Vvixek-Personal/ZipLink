# ZipLink Archive Context

- **Archive:** ziplink-browser-test.zip
- **Share ID:** `SyVYsHmV2uanhs0MOi8XxOZM9j8M2DIU`
- **Created:** 2026-11-22T10:52:33.696Z
- **Expires:** 2026-11-29T10:52:33.696Z
- **Total Files:** 5
- **Context Size Budget:** 512 KB

> Notice: Unlisted share — anyone with this URL can read these files. Generated deterministically without AI.

## File Tree

- `assets/logo.png` (10 B)
- `config/app.yml` (45 B)
- `public/xss.html` (119 B)
- `scripts/setup.sh` (39 B)
- `src/index.ts` (110 B)

## Readable Text Files
### config/app.yml

Size: 45 B

```yaml
service: ziplink
retention:
  defaultDays: 7

```

### public/xss.html

Size: 119 B

```html
<!doctype html>
<html>
  <body>
    <h1>Hello</h1>
    <script>window.__xssExecuted = true;</script>
  </body>
</html>

```

### scripts/setup.sh

Size: 39 B

```bash
#!/usr/bin/env bash
echo "Setup ready"

```

### src/index.ts

Size: 110 B

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
  export const editedFlag = true;
}

```
## Omitted Files (1)

- `assets/logo.png` (10 B) — binary file
