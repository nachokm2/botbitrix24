"""
Servidor FastAPI del agente de voz Pipecat (Twilio).  PoC / esqueleto.

Rutas:
- POST /twiml           -> devuelve el TwiML <Connect><Stream> (Twilio lo pide al recibir/originar la llamada)
- WS   /ws              -> stream de audio de Twilio; arranca el pipeline (bot.run_bot)
- POST /dialout         -> inicia una llamada SALIENTE por Twilio apuntando a /twiml

Correr:  uvicorn server:app --host 0.0.0.0 --port 7860   (o `python server.py`)
Exponer: un dominio público con WSS (Railway, Fly, o ngrok para pruebas).
Config Twilio (entrante): en el número, Voice webhook = POST https://<tu-host>/twiml
"""

import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse
from twilio.rest import Client as TwilioClient
from twilio.twiml.voice_response import Connect, Stream, VoiceResponse

from pipecat.runner.utils import parse_telephony_websocket

from bot import run_bot

load_dotenv()
app = FastAPI()

PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")  # ej. https://tu-servicio.up.railway.app


def _ws_url() -> str:
    return PUBLIC_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws"


def _twiml() -> str:
    resp = VoiceResponse()
    connect = Connect()
    connect.append(Stream(url=_ws_url()))
    resp.append(connect)
    resp.pause(length=20)  # mantiene la llamada mientras el stream está activo
    return str(resp)


@app.post("/twiml")
async def twiml(_request: Request) -> HTMLResponse:
    return HTMLResponse(content=_twiml(), media_type="application/xml")


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    _transport_type, call_data = await parse_telephony_websocket(websocket)
    await run_bot(websocket, call_data)


@app.post("/dialout")
async def dialout(request: Request):
    body = await request.json()
    to = body.get("to_number")
    frm = body.get("from_number") or os.getenv("TWILIO_FROM_NUMBER")
    if not to or not frm:
        return {"ok": False, "error": "Faltan to_number / from_number"}
    client = TwilioClient(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))
    call = client.calls.create(to=to, from_=frm, url=f"{PUBLIC_URL}/twiml", method="POST")
    return {"ok": True, "call_sid": call.sid}


@app.get("/health")
async def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "7860")))
