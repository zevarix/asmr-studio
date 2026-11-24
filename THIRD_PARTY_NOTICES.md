# Third-party notices

ASMR Studio's original application code is covered by the [MIT License](LICENSE).
Third-party dependencies retain their own licenses.

## Sounds

Starter audio is downloaded separately into local application storage.
Its permissions are independent of the application license. See
[the sound library](docs/sound-library.md#recording-credits-and-licenses) for each
sound's creator, source, permission, and processing changes.

The starter rain and ocean recordings use CC BY 4.0; sharing a mix containing
them requires the relevant attribution, license links, and change notices.
**Recipe & credits** in the export panel provides the captured source declarations.
Personal imports retain their original permissions.

Window rain, Rain on wood, and Small brook were rendered with Earshot at revision
`7a7f7c5c70d4a763a1eca4b3666af7c77e313f97`. Earshot's code is MIT-licensed; the
studio distributes only these prepared audio renders, under Earshot's separate
output permission. The two recording-derived sounds retain their original CC0
source credits. See [the preparation record](docs/earshot-water-sounds.md) for
the pinned permission statement and complete provenance. Earshot and its Python
dependencies are not runtime dependencies of ASMR Studio.

## Model Context Protocol TypeScript SDK

The optional local MCP adapter uses `@modelcontextprotocol/server` 2.4.0.
Its integration tests use `@modelcontextprotocol/client` 2.4.0. These packages
are licensed under Apache-2.0 and retain their upstream license notices.

- Source: https://github.com/modelcontextprotocol/typescript-sdk
- License: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE
- SDK documentation: https://ts.sdk.modelcontextprotocol.io/v2/

## Tabler Icons

ASMR Studio uses `@tabler/icons-react` 3.52.0 for interface icons.
Source: https://github.com/tabler/tabler-icons

MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
