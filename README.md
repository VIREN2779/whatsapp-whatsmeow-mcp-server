# whatsapp-whatsmeow-mcp-server

An MCP (Model Context Protocol) server that connects Claude (or any MCP-compatible client) to your personal WhatsApp account.

Once linked, it lets an LLM read your chat history — text, images, videos, documents, and voice notes — look up contacts, and send messages or media to individuals and groups. It talks to WhatsApp through the [whatsmeow](https://github.com/tulir/whatsmeow) library over the WhatsApp Web multi-device API, and everything is cached in a local SQLite database. Nothing leaves your machine unless a tool call explicitly pulls it in for the LLM.

## Prerequisites

- Go
- Python 3.6+
- Claude Desktop (or Cursor / Opencode)
- [uv](https://astral.sh/uv/install.sh) — `curl -LsSf https://astral.sh/uv/install.sh | sh`
- FFmpeg *(optional)* — only required if you want audio files auto-converted to `.ogg` Opus so they show up as playable voice notes. Without it, audio can still be sent as a plain file via `send_file`.

## Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/VIREN2779/whatsapp-whatsmeow-mcp-server.git
   cd whatsapp-whatsmeow-mcp-server
   ```

2. **Start the Go bridge**

   ```bash
   cd whatsapp-bridge
   go run main.go
   ```

   On first run it'll show a QR code — scan it from WhatsApp on your phone to link the device. Expect to re-scan roughly every 20 days.

3. **Point your MCP client at the Python server**

   Fill in your own paths and drop this into the client's config:

   ```json
   {
     "mcpServers": {
       "whatsapp": {
         "command": "{{PATH_TO_UV}}",
         "args": [
           "--directory",
           "{{PATH_TO_REPO}}/whatsapp-mcp/whatsapp-mcp-server",
           "run",
           "main.py"
         ]
       }
     }
   }
   ```

   - `{{PATH_TO_UV}}` → output of `which uv`
   - `{{PATH_TO_REPO}}` → output of `pwd` from inside the cloned repo

   Config file locations by client:

   | Client | Path |
   |---|---|
   | Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Opencode | `C:\Users\sp\.config\opencode\opencode.json` |
   | Cursor | `~/.cursor/mcp.json` |
