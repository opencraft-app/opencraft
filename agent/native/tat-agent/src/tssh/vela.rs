use super::handler::{Handler, HandlerExt, JsonHandler};
use crate::network::{PtyOutput, VelaProbe, VelaProbeAck};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;
use tokio::sync::Mutex;

const MAGIC: &str = "VelaSocket";
const VERSION: u16 = 1;
const DEFAULT_WINDOW: u32 = 1024 * 1024;
const MAX_UNACKED_PER_STREAM: usize = 256;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_UNACKED_BYTES_PER_STREAM: usize = 1024 * 1024;
const MAX_UNACKED_BYTES_PER_CONN: usize = 16 * 1024 * 1024;

static VELA_CONNS: LazyLock<Mutex<HashMap<String, ConnState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn register_vela_handlers() {
    JsonHandler::<VelaProbe>::register().await;
}

impl Handler for JsonHandler<VelaProbe> {
    const MSG_TYPE: &str = "VelaProbe";
    const NEED_CHANNEL: bool = false;

    async fn process(self) {
        let req = &self.request.data;
        info!("=>vela_probe `{}`, probe_id: {}", self.id(), req.probe_id);
        self.reply(VelaProbeAck {
            probe_id: req.probe_id.clone(),
            accepted: true,
            payload: req.payload.clone(),
        })
        .await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
enum FrameType {
    Hello,
    HelloAck,
    Resume,
    ResumeAck,
    Data,
    Ack,
    Ping,
    Pong,
    Close,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Frame {
    magic: String,
    version: u16,
    frame_type: FrameType,
    conn_id: String,
    token: String,
    epoch: u64,
    stream_id: u32,
    seq: u64,
    ack: u64,
    window: u32,
    #[serde(default)]
    payload: String,
    #[serde(default)]
    error: String,
}

impl Frame {
    fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let frame: Self = serde_json::from_slice(bytes).context("decode VelaSocket frame")?;
        frame.validate()?;
        Ok(frame)
    }

    fn to_pty_output(&self) -> PtyOutput {
        PtyOutput {
            output: STANDARD.encode(serde_json::to_vec(self).unwrap_or_default()),
        }
    }

    fn payload_bytes(&self) -> Result<Vec<u8>> {
        if self.payload.is_empty() {
            return Ok(Vec::new());
        }
        STANDARD
            .decode(&self.payload)
            .context("decode VelaSocket payload")
    }

    fn control(frame_type: FrameType, conn_id: &str, token: &str, epoch: u64) -> Self {
        Self {
            magic: MAGIC.to_owned(),
            version: VERSION,
            frame_type,
            conn_id: conn_id.to_owned(),
            token: token.to_owned(),
            epoch,
            stream_id: 0,
            seq: 0,
            ack: 0,
            window: DEFAULT_WINDOW,
            payload: String::new(),
            error: String::new(),
        }
    }

    fn ack(req: &Frame, ack: u64) -> Self {
        let mut frame = Self::control(FrameType::Ack, &req.conn_id, &req.token, req.epoch);
        frame.stream_id = req.stream_id;
        frame.ack = ack;
        frame
    }

    fn data(req: &Frame, seq: u64, payload: &[u8]) -> Self {
        let mut frame = Self::control(FrameType::Data, &req.conn_id, &req.token, req.epoch);
        frame.stream_id = req.stream_id;
        frame.seq = seq;
        frame.payload = STANDARD.encode(payload);
        frame
    }

    fn reset(req: &Frame, reason: impl ToString) -> Self {
        let mut frame = Self::control(FrameType::Reset, &req.conn_id, &req.token, req.epoch);
        frame.error = reason.to_string();
        frame
    }

    fn validate(&self) -> Result<()> {
        if self.magic != MAGIC {
            bail!("invalid VelaSocket magic `{}`", self.magic);
        }
        if self.version != VERSION {
            bail!("unsupported VelaSocket version {}", self.version);
        }
        if self.conn_id.is_empty() {
            bail!("empty VelaSocket conn_id");
        }
        if self.token.is_empty() {
            bail!("empty VelaSocket token");
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct PendingFrame {
    frame: Frame,
    payload_len: usize,
}

#[derive(Debug, Clone)]
struct ConnState {
    token: String,
    epoch: u64,
    recv_next: HashMap<u32, u64>,
    send_next: HashMap<u32, u64>,
    unacked: HashMap<u32, BTreeMap<u64, PendingFrame>>,
}

impl ConnState {
    fn new(token: String, epoch: u64) -> Self {
        Self {
            token,
            epoch,
            recv_next: HashMap::new(),
            send_next: HashMap::new(),
            unacked: HashMap::new(),
        }
    }

    fn check_token(&self, frame: &Frame) -> Result<()> {
        if self.token != frame.token {
            bail!("VelaSocket token mismatch");
        }
        Ok(())
    }

    fn ack_data(&mut self, frame: &Frame) -> (u64, bool) {
        let expected = self.recv_next.entry(frame.stream_id).or_insert(1);
        if frame.seq == *expected {
            *expected += 1;
            return (expected.saturating_sub(1), true);
        }
        (expected.saturating_sub(1), false)
    }

    fn next_data_seq(&mut self, stream_id: u32) -> u64 {
        let seq = self.send_next.entry(stream_id).or_insert(1);
        let current = *seq;
        *seq += 1;
        current
    }

    fn track_unacked(&mut self, frame: Frame) -> Result<()> {
        let stream_id = frame.stream_id;
        let payload_len = frame.payload_bytes()?.len();
        let stream_pending = self.unacked_bytes(stream_id);
        let total_pending = self.total_unacked_bytes();
        let pending_len = self.unacked_len(stream_id);

        if pending_len >= MAX_UNACKED_PER_STREAM {
            bail!(
                "VelaSocket stream {} pending frame limit exceeded: pending={} max={}",
                stream_id,
                pending_len,
                MAX_UNACKED_PER_STREAM
            );
        }
        if stream_pending.saturating_add(payload_len) > MAX_UNACKED_BYTES_PER_STREAM {
            bail!(
                "VelaSocket stream {} pending byte limit exceeded: pending={} payload={} max={}",
                stream_id,
                stream_pending,
                payload_len,
                MAX_UNACKED_BYTES_PER_STREAM
            );
        }
        if total_pending.saturating_add(payload_len) > MAX_UNACKED_BYTES_PER_CONN {
            bail!(
                "VelaSocket conn pending byte limit exceeded: pending={} payload={} max={}",
                total_pending,
                payload_len,
                MAX_UNACKED_BYTES_PER_CONN
            );
        }

        self.unacked
            .entry(stream_id)
            .or_default()
            .insert(frame.seq, PendingFrame { frame, payload_len });
        Ok(())
    }

    fn mark_acked(&mut self, stream_id: u32, ack: u64) {
        if let Some(pending) = self.unacked.get_mut(&stream_id) {
            pending.retain(|seq, _| *seq > ack);
        }
    }

    fn resend_unacked(&self, epoch: u64) -> Vec<Frame> {
        let mut frames = Vec::new();
        for pending in self.unacked.values() {
            for pending_frame in pending.values() {
                let mut frame = pending_frame.frame.clone();
                frame.epoch = epoch;
                frames.push(frame);
            }
        }
        frames
    }

    fn unacked_len(&self, stream_id: u32) -> usize {
        self.unacked
            .get(&stream_id)
            .map(BTreeMap::len)
            .unwrap_or_default()
    }

    fn unacked_bytes(&self, stream_id: u32) -> usize {
        self.unacked
            .get(&stream_id)
            .map(|pending| pending.values().map(|frame| frame.payload_len).sum())
            .unwrap_or_default()
    }

    fn total_unacked_bytes(&self) -> usize {
        self.unacked
            .values()
            .flat_map(|pending| pending.values())
            .map(|frame| frame.payload_len)
            .sum()
    }
}

pub async fn handle_pty_payload(payload: &[u8]) -> Option<Vec<PtyOutput>> {
    let frame = Frame::from_bytes(payload).ok()?;
    let result = handle_frame(frame.clone()).await;
    let frames = match result {
        Ok(frames) => frames,
        Err(e) => vec![Frame::reset(&frame, format!("{e:#}"))],
    };
    Some(
        frames
            .into_iter()
            .map(|frame| frame.to_pty_output())
            .collect(),
    )
}

async fn handle_frame(frame: Frame) -> Result<Vec<Frame>> {
    let mut conns = VELA_CONNS.lock().await;

    match frame.frame_type {
        FrameType::Hello => {
            let state = ConnState::new(frame.token.clone(), frame.epoch);
            conns.insert(frame.conn_id.clone(), state);
            let mut reply = Frame::control(
                FrameType::HelloAck,
                &frame.conn_id,
                &frame.token,
                frame.epoch,
            );
            reply.window = DEFAULT_WINDOW;
            Ok(vec![reply])
        }
        FrameType::Resume => {
            let state = conns
                .get_mut(&frame.conn_id)
                .ok_or_else(|| anyhow::anyhow!("unknown VelaSocket conn_id"))?;
            state.check_token(&frame)?;
            state.mark_acked(frame.stream_id, frame.ack);
            state.epoch = frame.epoch;
            let mut reply = Frame::control(
                FrameType::ResumeAck,
                &frame.conn_id,
                &frame.token,
                frame.epoch,
            );
            reply.ack = state
                .recv_next
                .values()
                .copied()
                .max()
                .unwrap_or(1)
                .saturating_sub(1);
            let mut replies = vec![reply];
            replies.extend(state.resend_unacked(frame.epoch));
            Ok(replies)
        }
        FrameType::Data => {
            let state = conns
                .get_mut(&frame.conn_id)
                .ok_or_else(|| anyhow::anyhow!("unknown VelaSocket conn_id"))?;
            state.check_token(&frame)?;
            let (ack, delivered) = state.ack_data(&frame);
            let mut replies = vec![Frame::ack(&frame, ack)];
            if delivered {
                let payload = frame.payload_bytes()?;
                if payload.len() > MAX_PAYLOAD_BYTES {
                    bail!(
                        "VelaSocket payload too large: payload={} max={}",
                        payload.len(),
                        MAX_PAYLOAD_BYTES
                    );
                }
                let echo = format!("agent echo: {}", String::from_utf8_lossy(&payload));
                let seq = state.next_data_seq(frame.stream_id);
                let echo_frame = Frame::data(&frame, seq, echo.as_bytes());
                state.track_unacked(echo_frame.clone())?;
                replies.push(echo_frame);
            }
            Ok(replies)
        }
        FrameType::Ack => {
            let state = conns
                .get_mut(&frame.conn_id)
                .ok_or_else(|| anyhow::anyhow!("unknown VelaSocket conn_id"))?;
            state.check_token(&frame)?;
            state.mark_acked(frame.stream_id, frame.ack);
            Ok(Vec::new())
        }
        FrameType::Ping => {
            let state = conns
                .get(&frame.conn_id)
                .ok_or_else(|| anyhow::anyhow!("unknown VelaSocket conn_id"))?;
            state.check_token(&frame)?;
            Ok(vec![Frame::control(
                FrameType::Pong,
                &frame.conn_id,
                &frame.token,
                frame.epoch,
            )])
        }
        FrameType::Close => {
            conns.remove(&frame.conn_id);
            Ok(vec![Frame::control(
                FrameType::Close,
                &frame.conn_id,
                &frame.token,
                frame.epoch,
            )])
        }
        FrameType::HelloAck | FrameType::ResumeAck | FrameType::Pong | FrameType::Reset => {
            Ok(Vec::new())
        }
    }
}
