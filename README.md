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

4. **Restart the client.** WhatsApp should now show up as a connected tool.

### Windows note

`go-sqlite` needs CGO, which is off by default on Windows. Install a C compiler (MSYS2 is the easy route — add its `ucrt64\bin` to `PATH`), then:

```bash
cd whatsapp-bridge
go env -w CGO_ENABLED=1
go run main.go
```

Skipping this gets you a `CGO_ENABLED=0` build error.

## How it's put together

Two pieces:

- **Go bridge** (`whatsapp-bridge/`) — handles the WhatsApp Web connection, QR login, and keeps a local SQLite store of chats/messages up to date.
- **Python MCP server** (`whatsapp-mcp-server/`) — exposes that data to Claude (or another MCP client) through the standard MCP tool interface.

Message history lives in SQLite under `whatsapp-bridge/store/`, indexed for fast lookups.

## Available tools

| Tool | What it does |
|---|---|
| `search_contacts` | Find contacts by name or number |
| `list_messages` | Pull messages with filters/context |
| `list_chats` | List chats + metadata |
| `get_chat` | Details on one chat |
| `get_direct_chat_by_contact` | Find a 1:1 chat for a contact |
| `get_contact_chats` | All chats a contact appears in |
| `get_last_interaction` | Most recent message with a contact |
| `get_message_context` | Surrounding messages for a given one |
| `send_message` | Send text to a number or group JID |
| `send_file` | Send an image, video, document, or raw audio |
| `send_audio_message` | Send audio as a playable voice note (needs `.ogg` Opus, or FFmpeg to convert) |
| `download_media` | Pull a message's media to a local path (needs `message_id` + `chat_jid`) |

Media received over WhatsApp is only stored as metadata until `download_media` is called — that's what actually fetches the file and hands back a path.

## Request flow

Claude → Python MCP server → Go bridge → WhatsApp API, and back the same way. Sends work the same route in reverse.

## Troubleshooting

- **uv not found** — add it to `PATH` or reference it by full path in the config.
- Both the Go bridge and the Python server need to be running simultaneously.
- **QR code won't show** — restart the bridge; if it still won't render, check your terminal's QR support.
- **Already linked** — the bridge reconnects silently if a session is already active, no QR needed.
- **Device limit hit** — remove an old linked device from WhatsApp (Settings → Linked Devices) and retry.
- **History not loading** — can take a few minutes after first auth, longer with a lot of chats.
- **Bridge out of sync with WhatsApp** — delete `whatsapp-bridge/store/messages.db` and `whatsapp-bridge/store/whatsapp.db`, then restart the bridge to re-auth from scratch.

General MCP + Claude Desktop setup issues: see the [MCP quickstart docs](https://modelcontextprotocol.io/quickstart/server#claude-for-desktop-integration-issues).