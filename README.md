# Factory safety console

<h1 align="center">🚀 Explore the live preview</h1>
<p align="center"><a href="https://factory-safety-tracker-153r.onrender.com"><strong>OPEN FACTORY SAFETY TRACKER →</strong></a></p>
<p align="center">See the operations dashboard in your browser.</p>

**Made By Sreesanth <3**

A React/Vite workplace safety dashboard with local browser cameras, a serial sensor adapter, configurable vision inference, and an incident review queue. Camera clips are recorded from the selected local camera. Alerts remain unverified until a permitted person reviews them; this prototype does not actuate equipment.

Copyright (c) 2026 Sreesanth. All rights reserved. This repository is for portfolio viewing and evaluation; see [LICENSE](LICENSE) for the project terms. Third-party components, datasets and model weights have their own licenses.

## How it works and technology stack

The browser discovers cameras the user grants access to, samples frames during active monitoring, and sends them to the authenticated local Node API. That API checks the user's role and zone, then forwards camera frames to the Python FastAPI vision service on loopback. The service runs the local YOLO/pose/action models and returns candidate detections. Node applies incident rules, priority and per-person duplicate cooldowns, then stores the incident and notification. The browser captures an eight-second clip if a camera is active. MongoDB persists data when configured; otherwise server memory is used and records are lost on restart. An operator or safety officer reviews each alert.

| Layer | Stack |
| --- | --- |
| Frontend | React 19, JavaScript, Vite 7, React Router 7, Motion 14 |
| Browser devices | MediaDevices (`getUserMedia`), Canvas, MediaRecorder, Web Serial |
| App API | Node.js custom Vite middleware, role/zone authorization, HTTP-only sessions |
| Storage | MongoDB Node.js driver 7, optional; process-memory fallback |
| Vision service | Python, FastAPI, Uvicorn, Pydantic |
| AI and image processing | PyTorch, Transformers/VideoMAE, Ultralytics YOLO26, OpenCV, NumPy, Supervision, ByteTrack |

See [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) for the full component and data-flow description, Level-2 DFD, model details, and production limitations.
See [MODEL_ARTIFACTS.md](MODEL_ARTIFACTS.md) for the preserved model inventory and SHA-256 checksums.

## Start the app

1. Use Node.js and run `npm install` in the project directory.
2. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the ignored `.env.local` file. The server reads those values and does not send the password to the browser.
3. Run `npm run dev`, then open the localhost address Vite prints.
4. Sign in, open **Device manager**, choose **Allow access and scan**, and grant camera permission.
5. Select a detected camera and press **Start feed**. In **Live Feed**, choose the area and duty shift, then start analysis.

The browser must stay open while a camera is recording or analyzing. Live camera access is available on localhost or HTTPS in browsers that support `getUserMedia`. Connected phones appear only when Windows exposes them as webcam devices (for example, through a phone webcam driver/app); a USB connection alone does not make a phone camera available to a web page.

### Render preview deployment

Deploy this repository as a **Web Service**, not a Static Site: the authenticated API is attached to the Vite preview server. Use `npm ci && npm run build` as the build command and `npm run preview -- --host 0.0.0.0 --port $PORT` as the start command. Set `ADMIN_USERNAME` and a strong `ADMIN_PASSWORD` in Render's environment settings. Vite automatically allows Render's `RENDER_EXTERNAL_HOSTNAME`; for a custom domain, add its hostname to the comma-separated `PREVIEW_ALLOWED_HOSTS` environment variable. This exposes the dashboard/API only. Live inference additionally requires a deployed Python vision service and a reachable `VISION_SERVICE_URL`; the default loopback address only works when Node and Python run on the same machine. Treat this as a demo deployment, not a production safety system, and disclose that browser camera frames are sent to your hosted server.

## Pages

- **Overview** shows live incident totals and animated charts for PPE, fire/smoke, electrical, fight, and accident signals.
- **Live Feed** groups locally discovered cameras by assigned area. It samples frames continuously while analysis is enabled and draws pose skeletons and confirmed action candidates.
- **Incidents** includes model and sensor alerts plus operator reports, with duty shift, review actions, and the actual camera clip when capture succeeded.
- **Device manager** lists cameras discovered by the browser and serial sensors selected by the user. Ended camera tracks and sensors that stop reporting are flagged.
- **Users** is admin-only and manages roles and zone access.

## Optional storage and model setup

Copy `.env.example` to `.env.local` if needed. Restart Vite after changing server variables.

### MongoDB Atlas

Set `MONGODB_URI` to the Atlas driver URI and `MONGODB_DATABASE=factory_safety`. Use a database user and allow the development machine’s IP in Network Access. Reserved characters in URI usernames or passwords must be percent-encoded. MongoDB stores users, incidents, notifications, and recorded clips. Without MongoDB, data is held in memory and is lost when the server restarts. Existing seeded public-demo cameras, sample sensors, workers, and sample incidents are removed during Mongo initialization.

### Local AI models

Roboflow-hosted inference has been removed. Camera frames now go from the authenticated Node server to the local Python service at `http://127.0.0.1:8765`; they are not uploaded to a model vendor. Model weights stay on this computer. No API key is needed.

#### Train the PPE detector

The project includes a YOLO26 training script for Ultralytics' [Construction-PPE dataset](https://docs.ultralytics.com/datasets/detect/construction-ppe). It has explicit `no_helmet`, `no_goggle`, `no_gloves`, `no_boots`, and `no_vest` classes alongside `Person` and PPE detections. The dataset is about 632 MB and released under CC BY 4.0; retain the Ultralytics dataset attribution if you redistribute a trained model or dataset-derived work.

In PowerShell, from the project folder:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r ai/requirements.txt
```

The training scripts require CUDA by default and stop if the current Python environment cannot see your GPU. If CUDA is unavailable, use the [official PyTorch install selector](https://pytorch.org/get-started/locally/) with Windows, Pip, Python, and its latest CUDA option. If Torch is installed CPU-only, uninstall it with `\.venv\Scripts\python.exe -m pip uninstall -y torch torchvision torchaudio`, then run the selector install command in this same venv.

Confirm CUDA in the training environment before starting:

```powershell
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable')"
```

If it prints `True` and the GPU name, run `\.venv\Scripts\python.exe ai/train_ppe.py --device 0 --batch 2`. The script prints the GPU it selected, downloads YOLO26s and the dataset, trains for 100 epochs, and writes the model to `ai/models/ppe/best.pt`. Start with `--batch 2` on this RTX 4050 laptop GPU with 6 GB VRAM; raise it only if memory permits.

Add these local settings to `.env.local`:

```dotenv
VISION_SERVICE_URL=http://127.0.0.1:8765
PPE_MODEL_PATH=ai/models/ppe/best.pt
HAZARD_MODEL_PATH=
POSE_MODEL_PATH=ai/models/pose/yolo26n-pose.pt
ACTION_MODEL_PATH=
ACTION_MODEL_ID=MCG-NJU/videomae-base-finetuned-kinetics
```

#### Start inference and the app

After training, keep a PowerShell terminal open for the Python service:

```powershell
.\.venv\Scripts\python.exe -m uvicorn ai.service:app --host 127.0.0.1 --port 8765
```

In a second terminal, run `npm run dev`. Open the app, sign in with a role allowed to analyze cameras, and choose **Live CCTV feed → Start all cameras**. It opens all browser-detected cameras and starts automatic frame analysis while the signed-in app remains open. The Live Feed status shows which model components are ready. The server runs YOLO detectors locally and applies a separate ByteTrack tracker per camera. The PPE model needs its explicit missing-equipment classes; labels that only say `person`, `helmet`, or `vest` cannot establish that required gear is missing.

Browser camera streams cannot continue after the browser or app is closed, the user signs out, or the computer sleeps. This is automatic in-session monitoring, not unattended 24/7 surveillance. For true 24/7 coverage, use network CCTV cameras with RTSP/ONVIF streams and run camera capture/inference as a supervised server or Windows service on an always-on computer.

#### Other safety classes

The Construction-PPE weights do not detect fire, smoke, sparks, fights, falls, or short circuits. A separate public YOLO26 checkpoint detects visible fire and smoke. Download it without an API key:

```powershell
.\.venv\Scripts\python.exe ai\download_hazard_model.py
```

The verified checkpoint is saved to `ai/models/hazards/fire_smoke.pt` and loads automatically after restarting the Python vision service. It detects fire/smoke only. The upstream [seawsurf/fire_yolo](https://huggingface.co/seawsurf/fire_yolo) checkpoint is YOLO26n and CC BY 4.0; retain attribution when redistributing it. For visual electrical spark/arc alerts, train a spark-labeled checkpoint using the workflow below; compatible connected sensors can also submit electrical events immediately. Prepare a YOLO-format dataset YAML with labeled site images:

```powershell
.\.venv\Scripts\python.exe ai/train_hazard.py --data path\to\hazards.yaml --batch 2
```

This writes `ai/models/hazards/best.pt`; set `HAZARD_MODEL_PATH=ai/models/hazards/best.pt` in `.env.local` and restart the Python service. This custom detector runs alongside the bundled fire/smoke model. Include labels such as `fire`, `smoke`, `spark`, `sparks`, `arc`, or `electrical arc`; the incident service maps those names to their queue categories. Electrical and fire events can also arrive from compatible connected sensors using the existing serial/gateway format.

#### Pose and video action models

YOLO26n-Pose is included at `ai/models/pose/yolo26n-pose.pt` and provides 17 COCO keypoints per person. VideoMAE uses rolling 16-frame clips and confirms fight/fall cues across matching predictions; confirmation tolerates a changing worker track list. Per-camera ByteTrack IDs are attached to person detections; the Node service applies a 90-second per-track/type cooldown and increments repeated occurrences at most once every 30 seconds. The browser submits camera frames about once per second while monitoring is active.

The pretrained VideoMAE Kinetics-400 checkpoint is a general action model. It can surface possible cues, but it is not trained to recognize workplace incidents. If its weights are not cached, run the model downloader while online once; no API key is needed. The upstream checkpoint is CC BY-NC 4.0, so it is unsuitable for commercial deployment without a different licensed checkpoint. For task-specific fall and fight classes, download UR Fall and RWF-2000 and fine-tune:

```powershell
.\.venv\Scripts\python.exe ai\download_ur_fall.py
.\.venv\Scripts\python.exe ai\download_rwf2000.py
.\.venv\Scripts\python.exe ai\download_videomae.py
.\.venv\Scripts\python.exe ai\train_action.py --data datasets\ur-fall --data datasets\rwf2000\extracted\RWF-2000 --device cuda --epochs 5 --batch-size 1 --max-per-class 300
```

The trainer accepts multiple roots with `train/<class>` and `val/<class>` folders, maps RWF `Fight`/`NonFight` to `fight`/`normal`, and saves the best checkpoint to `ai/models/action`. It preserves each dataset's provided train/validation split and samples training clips evenly across classes. `--max-per-class 300` caps the training set to keep fine-tuning practical on a 6 GB laptop GPU; omit it to use every training clip. Set `ACTION_MODEL_PATH=ai/models/action` in `.env.local` and restart the Python service.

| Dataset | How it fits this pipeline | Availability and terms |
| --- | --- | --- |
| [RWF-2000](https://zenodo.org/records/15687512) | Fight vs. non-fight CCTV clips | 13-part 8.8 GiB archive; the downloader verifies Zenodo MD5 checksums and extracts locally. The Zenodo record declares CC BY 4.0; retain attribution. |
| [UBI-Fights / TAG-Net](https://github.com/Karthikkosuri/Temporal_Attention_Gate_Network_For_Violence_Detection) | Fight vs. non-fight training; the linked project has its own TAG-Net checkpoints | Dataset download is separate from the model repository; confirm its license and access before using it. |
| [NTU CCTV-Fights](https://rose1.ntu.edu.sg/dataset/cctvFights/) | CCTV fight clips with temporal segments | Requires researcher registration and approval; academic, non-commercial conditions apply. |
| [XD-Violence](https://roc-ng.github.io/XD-Violence/) | Long, weakly labelled multi-event videos | Public download links are provided; its 217 hours makes preparation/training large, and its weak labels need adaptation to clip classification. |
| [UR Fall Detection](https://fenix.ur.edu.pl/~mkepski/ds/uf.html) | Fall vs. activities-of-daily-living clips | Public MP4s; CC BY-NC-SA 4.0, non-commercial academic use. The downloader fetches these clips and keeps sequence-level train/validation splits. |

All dataset footage and derived weights must follow their source terms. UR Fall and the pretrained VideoMAE checkpoint are non-commercially licensed. RWF-2000 is offered under CC BY 4.0 on Zenodo; include attribution when sharing derived work. The downloaded fire/smoke model is listed as CC BY 4.0; electrical spark detection still needs a suitable custom checkpoint or sensor. Treat model signals as prompts for human review, not verified safety findings.

The [Ultralytics Construction-PPE dataset](https://docs.ultralytics.com/datasets/detect/construction-ppe) documentation is the source for the training archive and labels. Use the [Ultralytics tracking guide](https://docs.ultralytics.com/modes/track) for ByteTrack background and tracker behavior.

## Sensor connection

On supported browsers (currently Chrome/Edge with Web Serial), open **Device manager → Connect sensor** and choose a USB/serial port. The app expects a newline-delimited JSON stream at 9600 baud. For example:

```json
{"sensorId":"smoke-1","type":"smoke","value":0.82,"threshold":0.7}
```

Set `triggered: true` to raise an event directly. Supported `type` values are `smoke`, `fire`, `electrical`, `short_circuit`, `fight`, `accident`, and `ppe`. The hardware or its gateway must actually emit this format; the browser cannot detect arbitrary sensors without their driver/protocol. A connected but quiet port is marked unresponsive after 30 seconds.

For a separate networked camera/sensor gateway, set a random `DEVICE_INGEST_TOKEN` and POST authorized events to `/api/ingest/events` with an `Authorization: Bearer <token>` header. Include `zoneId`, `signalType`, `deviceId`, and optional `description`, `confidence`, and normalized bounding box. The app no longer accepts public video URLs; incident playback uses clips captured from a local browser camera.

## Access and safety notes

Server-side authorization checks the role and assigned zone on every protected API action. Operators can only access assigned zones. Safety officers and admins can analyze feeds and review incidents; only admins manage users. Sampled camera frames are sent to the local Python inference service over loopback; event clips are uploaded to the local app server and, when configured, MongoDB.

Camera analysis is frame-sampled and only runs while an authorized user enables it. Sensor support requires compatible hardware and a configured serial protocol. When a signal arrives, the browser records an eight-second WebM clip from the active camera and uploads it; MongoDB is required for clip persistence across server restarts. Human review is required for all alerts.

## Design system

The UI uses the Vantage direction from Hallmark with steel surfaces, Geologica, corner frames, and a restrained lime signal. The light/dark switch persists locally and animates the sun/moon icon. Charts animate as their data renders. `tokens.css` holds the shared palette, type, spacing, and motion tokens.
