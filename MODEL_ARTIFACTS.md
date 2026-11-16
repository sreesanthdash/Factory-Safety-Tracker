# Saved AI artifacts

The ZIP and local project retain the current weights and training progress. SHA-256 values below can be used to verify the files after copying or extracting.

| Artifact | Purpose / status | SHA-256 |
| --- | --- | --- |
| `ai/models/ppe/best.pt` | Current PPE model used by inference | `5C31012E42D1F66B4605FAA648A8FC53BDB09BAE35DB38E856923FF92FC318F1` |
| `ai/runs/construction-ppe/weights/best.pt` | Best checkpoint from the retained PPE training run; identical to the deployed copy above | `5C31012E42D1F66B4605FAA648A8FC53BDB09BAE35DB38E856923FF92FC318F1` |
| `ai/runs/construction-ppe/weights/last.pt` | Last checkpoint from that PPE run, retained for continued fine-tuning | `58F1F6BBFF593F80CAEED06D07AEF872AEA6532673746AA8B9A74453CEB14FA4` |
| `ai/models/hazards/fire_smoke.pt` | Visible fire/smoke detection weights | `D2B0BE214F45FA01D2044B960C3CB4DA4BF65C06A89CF0A1967B0D40E8DB4B98` |
| `ai/models/pose/yolo26n-pose.pt` | YOLO26n pose weights | `EB3BB8268828AEAF515CEC23A4BFAFD793944A86FE9AF94BA7823609C14522A9` |
| `ai/models/action/model.safetensors` | VideoMAE checkpoint configured with `fall`, `fight`, and `normal` labels; no action validation report is present, so treat it as experimental | `28E89C09E0507063E97E4FDAF42ECB310B505FB52AD872B45B012A4E82A92EEB` |

The PPE run also retains `results.csv`, arguments, and validation/training plots. The root `yolo26n-pose.pt` was byte-identical to the pose file above and is omitted from the portfolio ZIP. Raw datasets are excluded from the ZIP to avoid redistributing large third-party datasets; the project download scripts remain available for future fine-tuning. Review `README.md` for dataset/model attribution and license conditions.
