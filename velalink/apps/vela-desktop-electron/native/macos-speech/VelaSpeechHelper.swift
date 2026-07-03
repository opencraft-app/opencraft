import AVFoundation
import Foundation
import Speech

struct SpeechEvent: Encodable {
    let type: String
    let state: String?
    let text: String?
    let code: String?
    let message: String?

    init(type: String, state: String? = nil, text: String? = nil, code: String? = nil, message: String? = nil) {
        self.type = type
        self.state = state
        self.text = text
        self.code = code
        self.message = message
    }
}

func emit(_ event: SpeechEvent) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else {
        return
    }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func argumentValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else {
        return nil
    }
    return args[index + 1]
}

final class SpeechRunner {
    private let audioEngine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastTranscript = ""
    private var didEmitFinalTranscript = false
    private var isStopping = false

    init(language: String) {
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    }

    func start() {
        emit(SpeechEvent(type: "state", state: "requesting-permission"))
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            DispatchQueue.main.async {
                guard speechStatus == .authorized else {
                    emit(SpeechEvent(
                        type: "error",
                        code: "speech_permission_denied",
                        message: "Speech recognition permission was not granted."
                    ))
                    emit(SpeechEvent(type: "state", state: "error"))
                    self.exitSoon()
                    return
                }

                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard granted else {
                            emit(SpeechEvent(
                                type: "error",
                                code: "microphone_permission_denied",
                                message: "Microphone permission was not granted."
                            ))
                            emit(SpeechEvent(type: "state", state: "error"))
                            self.exitSoon()
                            return
                        }
                        self.beginRecognition()
                    }
                }
            }
        }
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
        emit(SpeechEvent(type: "state", state: "stopping"))
        if !lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !didEmitFinalTranscript {
            emit(SpeechEvent(
                type: "final_transcript",
                text: lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            ))
            didEmitFinalTranscript = true
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()
        task?.finish()
        exitSoon()
    }

    private func beginRecognition() {
        guard recognizer.isAvailable else {
            emit(SpeechEvent(
                type: "error",
                code: "speech_recognizer_unavailable",
                message: "Speech recognizer is unavailable for the selected locale."
            ))
            emit(SpeechEvent(type: "state", state: "error"))
            exitSoon()
            return
        }

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        request = recognitionRequest

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(SpeechEvent(
                type: "error",
                code: "audio_engine_start_failed",
                message: error.localizedDescription
            ))
            emit(SpeechEvent(type: "state", state: "error"))
            exitSoon()
            return
        }

        task = recognizer.recognitionTask(with: recognitionRequest) { result, error in
            if let result {
                let transcript = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !transcript.isEmpty {
                    self.lastTranscript = transcript
                    emit(SpeechEvent(type: result.isFinal ? "final_transcript" : "partial_transcript", text: transcript))
                    if result.isFinal {
                        self.didEmitFinalTranscript = true
                    }
                }
            }
            if let error, !self.isStopping {
                emit(SpeechEvent(
                    type: "error",
                    code: "speech_recognition_failed",
                    message: error.localizedDescription
                ))
                emit(SpeechEvent(type: "state", state: "error"))
                self.stop()
            }
        }

        emit(SpeechEvent(type: "state", state: "listening"))
    }

    private func exitSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            emit(SpeechEvent(type: "state", state: "idle"))
            Foundation.exit(0)
        }
    }
}

let language = argumentValue("--language") ?? Locale.current.identifier
let runner = SpeechRunner(language: language)

DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
            DispatchQueue.main.async {
                runner.stop()
            }
            break
        }
    }
}

runner.start()
RunLoop.main.run()
