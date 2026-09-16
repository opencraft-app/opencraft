import Foundation
import Speech
import AVFoundation
import CoreAudio
import AudioToolbox

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

func propertyString(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString?; var size = UInt32(MemoryLayout<CFString?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value as String?
}
func inputDevices() -> [(id: AudioDeviceID, uid: String, name: String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0,
              let uid = propertyString(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return (id, uid, propertyString(id, kAudioObjectPropertyName) ?? "Microphone")
    }
}
func authorizationName() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "notDetermined"
    }
}
func probe(_ language: String) {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
    emit(["supported": recognizer != nil, "available": recognizer?.isAvailable ?? false,
          "language": language, "supportsOnDeviceRecognition": recognizer?.supportsOnDeviceRecognition ?? false,
          "authorization": authorizationName(), "devices": inputDevices().map { ["id": $0.uid, "name": $0.name] }])
}

enum RecognitionResultAction { case ignore, update, rotate, finish }
final class RecognitionTaskLifecycle {
    private(set) var epoch = 0
    private(set) var stopping = false
    private var closed = false
    func beginTask() -> (epoch: Int, id: String)? {
        guard !closed, !stopping else { return nil }
        epoch += 1
        return (epoch, UUID().uuidString)
    }
    func result(_ taskEpoch: Int, final: Bool) -> RecognitionResultAction {
        guard !closed, taskEpoch == epoch else { return .ignore }
        return final ? (stopping ? .finish : .rotate) : .update
    }
    func stop() { stopping = true }
    func cancel() { closed = true; epoch += 1 }
}
final class RecognitionInput {
    let request: SFSpeechAudioBufferRecognitionRequest
    let id: String
    var frames: UInt64 = 0
    init(_ request: SFSpeechAudioBufferRecognitionRequest, _ id: String) { self.request = request; self.id = id }
}

final class Capture {
    private var generation = 0
    private var engine: AVAudioEngine?
    private let inputLock = NSLock()
    private var input: RecognitionInput?
    private let lifecycle = RecognitionTaskLifecycle()
    private var transcriptSequence = 0
    private var task: SFSpeechRecognitionTask?
    private var tapped = false
    private var finished = false
    private var stopping: Bool { lifecycle.stopping }
    private var hasText = false

    func shutdownAudio() {
        if let engine = engine {
            engine.stop()
            if tapped { engine.inputNode.removeTap(onBus: 0) }
        }
        tapped = false; engine = nil
    }
    private func takeInput() -> RecognitionInput? {
        inputLock.lock(); defer { inputLock.unlock() }
        let previous = input; input = nil; return previous
    }
    private func append(_ buffer: AVAudioPCMBuffer) {
        inputLock.lock(); defer { inputLock.unlock() }
        input?.frames += UInt64(buffer.frameLength)
        input?.request.append(buffer)
    }
    private func transcript(_ id: String, _ phase: String, _ text: String) {
        transcriptSequence += 1
        emit(["type": "utterance", "utteranceId": id, "sequence": transcriptSequence, "phase": phase, "text": text])
    }
    func terminal(_ code: String? = nil, _ message: String? = nil) {
        guard !finished else { return }
        finished = true; generation += 1; lifecycle.cancel(); shutdownAudio()
        takeInput()?.request.endAudio(); task?.cancel(); task = nil
        if let code = code { emit(["type": "error", "code": code, "message": message ?? "系统语音输入失败，请重试"]) }
        else { emit(["type": "end"]) }
        exit(0)
    }
    func handle(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "cancel": terminal()
        case "stop":
            guard !finished, !stopping else { return }
            lifecycle.stop()
            emit(["type": "status", "phase": "transcribing"])
            shutdownAudio()
            guard let current = takeInput() else { terminal(); return }
            current.request.endAudio()
            if current.frames == 0 {
                transcript(current.id, "final", ""); terminal(); return
            }
            task?.finish()
        case "start": start(body)
        default: terminal("unknown", "无效的语音操作")
        }
    }
    private func start(_ body: [String: Any]) {
        guard generation == 0, !finished else { terminal("busy", "已有语音输入正在执行"); return }
        generation += 1; let epoch = generation
        let language = body["language"] as? String ?? Locale.current.identifier
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
            terminal("not-supported", "系统不支持当前识别语言"); return
        }
        let preferred = body["deviceId"] as? String
        let device = preferred.flatMap { uid in inputDevices().first { $0.uid == uid } }
        if preferred != nil && device == nil { terminal("audio-capture", "所选麦克风不可用，请在设置中重新选择"); return }
        emit(["type": "status", "phase": "starting"])
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard !self.finished, self.generation == epoch, !self.stopping else { return }
                guard status == .authorized else { self.terminal("permission-denied", "请在系统设置中允许 OpenCraft 使用语音识别"); return }
                AVCaptureDevice.requestAccess(for: .audio) { allowed in
                    DispatchQueue.main.async {
                        guard !self.finished, self.generation == epoch, !self.stopping else { return }
                        guard allowed else { self.terminal("permission-denied", "请在系统设置中允许 OpenCraft 使用麦克风"); return }
                        self.record(recognizer, device, epoch)
                    }
                }
            }
        }
    }
    private func record(_ recognizer: SFSpeechRecognizer, _ device: (id: AudioDeviceID, uid: String, name: String)?, _ epoch: Int) {
        guard recognizer.isAvailable else { terminal("network", "系统语音识别当前不可用，请稍后重试"); return }
        let engine = AVAudioEngine(); self.engine = engine
        let node = engine.inputNode
        if let device = device {
            guard let current = inputDevices().first(where: { $0.uid == device.uid }) else {
                terminal("audio-capture", "所选麦克风已断开，请重新选择"); return
            }
            var id = current.id
            guard let unit = node.audioUnit,
                  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
                terminal("audio-capture", "无法使用所选麦克风"); return
            }
        }
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { terminal("audio-capture", "麦克风没有可用音频流"); return }
        startUtterance(recognizer)
        guard !finished else { return }
        var meterFrames: UInt64 = 0
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            self.append(buffer)
            meterFrames += UInt64(buffer.frameLength)
            guard meterFrames >= UInt64(format.sampleRate / 20), let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            meterFrames = 0
            var sum: Float = 0
            for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
            let level = min(1, sqrt(sum / Float(buffer.frameLength)) * 8)
            DispatchQueue.main.async {
                guard !self.finished, !self.stopping, self.generation == epoch else { return }
                emit(["type": "level", "level": level])
            }
        }
        tapped = true
        do {
            engine.prepare(); try engine.start()
            emit(["type": "status", "phase": "listening", "onDevice": recognizer.supportsOnDeviceRecognition])
        } catch { terminal("audio-capture", "麦克风启动失败，请重试") }
    }
    private func startUtterance(_ recognizer: SFSpeechRecognizer) {
        guard !finished, let token = lifecycle.beginTask() else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Do not claim offline support or force an unsupported mode.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        // Atomic routing replacement. AudioEngine stays alive across native task finals.
        inputLock.lock(); input = RecognitionInput(request, token.id); inputLock.unlock()
        transcript(token.id, "partial", "")
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                let action = self.lifecycle.result(token.epoch, final: result?.isFinal ?? false)
                guard action != .ignore else { return }
                if let result = result {
                    let text = result.bestTranscription.formattedString
                    if !text.isEmpty {
                        self.hasText = true
                    }
                    if result.isFinal || !text.isEmpty { self.transcript(token.id, result.isFinal ? "final" : "partial", text) }
                    if action == .finish { self.terminal(); return }
                    if action == .rotate { self.startUtterance(recognizer); return }
                }
                if error != nil { self.terminal(self.hasText ? "unknown" : "no-speech", self.hasText ? "系统识别中断，请重试" : "未能识别语音，请重试") }
            }
        }
    }
}

if CommandLine.arguments.contains("--verify-lifecycle") {
    let state = RecognitionTaskLifecycle(), first = state.beginTask()!
    precondition(state.result(first.epoch, final: false) == .update)
    precondition(state.result(first.epoch, final: true) == .rotate)
    let second = state.beginTask()!
    precondition(first.id != second.id && state.result(first.epoch, final: true) == .ignore)
    state.stop()
    precondition(state.beginTask() == nil && state.result(second.epoch, final: true) == .finish)
    state.cancel()
    precondition(state.result(second.epoch, final: false) == .ignore)
    emit(["verifiedTaskLifecycle": true]); exit(0)
}

if CommandLine.arguments.contains("--probe") {
    probe(CommandLine.arguments.last == "--probe" ? Locale.current.identifier : CommandLine.arguments.last!)
    exit(0)
}
let capture = Capture()
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count <= 64 * 1024, let data = line.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            DispatchQueue.main.async { capture.terminal("unknown", "无效的语音请求") }; break
        }
        DispatchQueue.main.async { capture.handle(body) }
    }
    DispatchQueue.main.async { capture.terminal() }
}
RunLoop.main.run()
