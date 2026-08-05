"""Setu, in Python — Twilio Media Streams bridged to a Dvaarik voice agent.

Setu itself is a Node library, but the protocol is small enough that you do
not need it. This is the whole bridge in one file: FastAPI serves the TwiML,
accepts Twilio's websocket, converts mu-law to PCM16 and back, and forwards
the interrupt so barge-in works.

    pip install fastapi uvicorn websockets httpx
    export DVAARIK_API_KEY=dvk_live_...
    uvicorn main:app --port 8080

Then point your Twilio number's voice webhook at
https://your-host/voice and call it.
"""

import asyncio
import audioop
import base64
import json
import os

import httpx
import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

API = os.environ.get("DVAARIK_BASE_URL", "https://api.developers.dvaarik.com")
KEY = os.environ["DVAARIK_API_KEY"]
PROMPT = os.environ.get(
    "AGENT_PROMPT", "You are a friendly receptionist. Answer in one short sentence."
)
PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "your-host")

app = FastAPI()


@app.post("/voice")
async def voice(_: Request) -> Response:
    """TwiML that hands the call's audio to our websocket."""
    return Response(
        content=(
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response><Connect>"
            f'<Stream url="wss://{PUBLIC_HOST}/twilio" />'
            "</Connect></Response>"
        ),
        media_type="application/xml",
    )


async def open_dvaarik_call() -> str:
    """Create the call and return its single-use socket URL."""
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(
            f"{API}/v1/calls",
            headers={"X-Api-Key": KEY},
            json={
                "prompt": PROMPT,
                "language": "en-IN",
                "grade": "standard",
                "voice": "tara",
                # Twilio is 8 kHz mu-law; we hand Dvaarik 8 kHz PCM16 and ask
                # for the same back, so nothing is resampled mid-call.
                "sample_rate_in": 8000,
                "sample_rate_out": 8000,
            },
        )
        r.raise_for_status()
        return r.json()["ws_url"]


@app.websocket("/twilio")
async def twilio_stream(ws: WebSocket) -> None:
    await ws.accept()
    stream_sid: str | None = None

    try:
        agent_url = await open_dvaarik_call()
    except Exception as e:                      # noqa: BLE001 - report and hang up
        print(f"could not start the agent: {e}")
        await ws.close()
        return

    async with websockets.connect(agent_url, max_size=None) as agent:

        async def caller_to_agent() -> None:
            nonlocal stream_sid
            while True:
                msg = json.loads(await ws.receive_text())
                event = msg.get("event")
                if event == "start":
                    stream_sid = msg["streamSid"]
                elif event == "media":
                    mulaw = base64.b64decode(msg["media"]["payload"])
                    await agent.send(audioop.ulaw2lin(mulaw, 2))
                elif event == "stop":
                    return

        async def agent_to_caller() -> None:
            async for frame in agent:
                if isinstance(frame, bytes):
                    if stream_sid is None:
                        continue
                    payload = base64.b64encode(audioop.lin2ulaw(frame, 2)).decode()
                    await ws.send_text(json.dumps({
                        "event": "media",
                        "streamSid": stream_sid,
                        "media": {"payload": payload},
                    }))
                    continue

                event = json.loads(frame)
                if event.get("type") == "interrupted" and stream_sid:
                    # THE important line. Twilio has audio queued toward the
                    # caller's ear; without this they keep hearing a sentence
                    # the agent already abandoned.
                    await ws.send_text(json.dumps(
                        {"event": "clear", "streamSid": stream_sid}))
                elif event.get("type") == "transcript":
                    print(f"{event['role']}: {event['text']}")
                elif event.get("type") == "session_ended":
                    return

        try:
            await asyncio.gather(caller_to_agent(), agent_to_caller())
        except (WebSocketDisconnect, websockets.ConnectionClosed):
            pass

    print("call ended")
