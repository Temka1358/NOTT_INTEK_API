# Legacy PHP, as deployed on cms1

The reviewed copies of the STB-facing scripts, used by the parity harness
(`test/parity/`) as the specification.

| File | Live location on cms1 | Live md5 (2026-10-23) |
|---|---|---|
| `tokenServer.php` | `/var/www/html/nott/` | `5119af3b97d9a65b32eda33eb3f460d2` |
| `metaData.php` | `/var/www/html/nott/` | `4e3e5a32f138cb9c16cc52bcb6662f8a` |
| `userinfo.php` | `/var/www/html/nott/` | `ed57c07aeeac12427e85d56a64b47af0` |
| `cdn.php` | `/var/www/html/nott/` | `152b5aa0e81cdd3a902f4185b781064f` |
| `cms_cdn.php` | `/var/www/cms/` | `234ffd5bc8b9335c1530ce56af7f9712` |

**Changed on purpose, so their md5 differs from the live file:**

- `cdn.php`: the hardcoded xvod `clientProviderPassword` (line 191) is replaced by a placeholder, so the secret never enters git. Nothing else is touched.
- `cms_cdn.php`: rebuilt from a paste, so its line endings differ; its response bytes were confirmed against the live server.
