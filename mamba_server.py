# mamba_server.py — менеджер задач Mamba
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shared import supabase, CANCEL_FLAGS

app = FastAPI(title="CLAW-AI Mamba Manager")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

class LikesTaskRequest(BaseModel):
    account_id: str
    limit: int = 10

class AutoReplyTaskRequest(BaseModel):
    account_id: str
    max_dialogs: int = 20

class StopTaskRequest(BaseModel):
    account_id: str

def enqueue_job(account_id: str, job_type: str, payload: dict) -> dict:
    existing = supabase.table("job_queue").select("id").eq("account_id", account_id).eq("type", job_type).in_("status", ["pending", "running"]).limit(1).execute()
    if existing.data:
        return existing.data[0]
    res = supabase.table("job_queue").insert({"account_id": account_id, "type": job_type, "payload": payload, "status": "pending"}).execute()
    return res.data[0]

@app.get("/")
def root():
    return {"ok": True}

@app.head("/")
def root_head():
    from fastapi.responses import Response
    return Response(status_code=200)

@app.head("/health")
def health_head():
    from fastapi.responses import Response
    return Response(status_code=200)

@app.get("/health")
def health():
    return {"ok": True, "service": "mamba-manager"}

@app.post("/api/tasks/likes-http")
def api_mamba_likes(payload: LikesTaskRequest):
    job = enqueue_job(payload.account_id, "likes-http", {"limit": payload.limit})
    return {"ok": True, "job_id": job["id"], "status": "pending"}

@app.post("/api/tasks/auto-reply-http")
def api_mamba_auto_reply(payload: AutoReplyTaskRequest):
    job = enqueue_job(payload.account_id, "auto-reply-http", {"max_dialogs": payload.max_dialogs})
    return {"ok": True, "job_id": job["id"], "status": "pending"}

@app.post("/api/tasks/auto-reply-http-loop")
def api_mamba_auto_reply_loop(payload: AutoReplyTaskRequest):
    job = enqueue_job(payload.account_id, "auto-reply-http", {"max_dialogs": payload.max_dialogs})
    return {"ok": True, "job_id": job["id"], "status": "pending"}

@app.post("/api/tasks/stop")
def api_stop(payload: StopTaskRequest):
    CANCEL_FLAGS[payload.account_id] = True
    supabase.table("job_queue").update({"status": "cancelled"}).eq("account_id", payload.account_id).in_("status", ["pending", "running"]).execute()
    return {"ok": True}

@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str):
    if not job_id or job_id == "undefined":
        return {"ok": False, "job": None}
    res = supabase.table("job_queue").select("*").eq("id", job_id).limit(1).execute()
    return {"ok": True, "job": res.data[0] if res.data else None}

@app.get("/api/jobs/account/{account_id}/active")
def api_get_active_job(account_id: str):
    res = supabase.table("job_queue").select("*").eq("account_id", account_id).in_("status", ["pending", "running"]).order("created_at", desc=True).limit(1).execute()
    return {"ok": True, "job": res.data[0] if res.data else None}

if __name__ == "__main__":
    import os
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8002)))