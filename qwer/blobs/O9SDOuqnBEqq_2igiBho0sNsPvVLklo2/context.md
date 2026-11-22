# ZipLink Archive Context

- **Archive:** ziplink-browser-test.zip
- **Share ID:** `O9SDOuqnBEqq_2igiBho0sNsPvVLklo2`
- **Created:** 2026-11-22T10:56:43.492Z
- **Expires:** 2026-11-29T10:56:43.492Z
- **Total Files:** 5
- **Context Size Budget:** 512 KB

> Notice: Unlisted share — anyone with this URL can read these files. Generated deterministically without AI.

## File Tree

- `assets/logo.png` (10 B)
- `config/app.yml` (45 B)
- `public/xss.html` (119 B)
- `scripts/setup.sh` (39 B)
- `src/index.ts` (76 B)

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

Size: 76 B

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

```
## Omitted Files (1)

- `assets/logo.png` (10 B) — binary file
