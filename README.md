# Agent Flow

Manager và Worker cho nghiên cứu ChatGPT Web trên các VM Windows trong mạng nội bộ. Thiết kế workflow bằng Node-RED, cấu hình lịch/điều kiện/vòng lặp, theo dõi và khôi phục job qua HTTP. Không dùng OpenAI API trả phí hoặc Codex.

## Bắt đầu

Yêu cầu **Node.js >=22.14**, Google Chrome trên mỗi VM Worker, phiên desktop Windows đang đăng nhập. Mỗi Worker dùng một tài khoản ChatGPT và một profile riêng do người dùng tự đăng nhập. Manager không cần tài khoản ChatGPT.

Trên mỗi máy, giải nén/copy mã nguồn rồi cài dependency:

```powershell
npm ci
```

### VM Manager

```powershell
npm run manager
# Hoặc:
.\scripts\start-manager.ps1 -Port 6060
```

Mở `http://localhost:6060` trên Manager hoặc `http://PCA:6060` trong mạng VM. `PCA` là hostname Manager phân giải được; có thể thay bằng IP. Chỉ cần cho phép TCP6060 từ subnet VM qua firewall; ứng dụng không tự sửa firewall hoặc cấu hình hypervisor. Worker vẫn cần Internet đến chatgpt.com.

Lần chạy đầu Manager tạo và in **admin token/password** cùng **pairing token**. Đăng nhập dashboard bằng admin token. Node-RED tại `/flows/` dùng username `admin`, password là cùng admin token. Token lưu ở `data/manager/secrets.json`; không chia sẻ thư mục dữ liệu hoặc đưa vào Git.

### VM Worker

```powershell
.\scripts\start-worker.ps1 -ManagerUrl http://PCA:6060 -WorkerId VM01
# Hoặc đặt biến môi trường rồi chạy npm run worker:
$env:AF_MANAGER_URL='http://PCA:6060'
$env:AF_WORKER_ID='VM01'
$env:AF_WORKER_ROLES='default'
$env:HEADLESS='false'
npm run worker
```

Mở `http://127.0.0.1:6061` trong chính VM, nhập pairing token của Manager. Chrome mở profile riêng; **người dùng tự đăng nhập ChatGPT**. Worker chỉ nhận job sau khi xác nhận phiên đăng nhập. Sau đó có thể khởi động lại với `HEADLESS=offscreen` hoặc script `-Offscreen`; đây là cửa sổ có giao diện đặt ngoài màn hình. Không chạy Worker trong Windows service Session0. CAPTCHA và yêu cầu đăng nhập cần người dùng xử lý trực tiếp.

Mỗi VM chỉ chạy một Worker với thư mục dữ liệu riêng. Không copy profile/cookie/SQLite của Worker đang chạy sang VM khác. Nếu chạy nhiều Worker thử nghiệm trên cùng máy, phải tách `AF_WORKER_DATA_DIR`, `CHROME_USER_DATA_DIR`, `AF_WORKER_UI_PORT`, `CDP_PORT` và Worker ID.

## Tạo và chạy workflow

1. Bấm **Tạo workflow mẫu** trên dashboard hoặc import `examples/review-repeat.json` trong Node-RED.
2. Mở editor, sửa SKILL, input, role, tiêu chí review, các nhánh và giới hạn. Bảng AND/OR trên Condition có thể tạo rule cơ bản; JSON hỗ trợ điều kiện phức tạp hơn.
3. **Deploy** chỉ lưu bản nháp. Về dashboard bấm **Publish** để kiểm tra và tạo phiên bản thực thi. Draft không tự tạo job.
4. Bấm **Chạy**, nhập input JSON. Ví dụ mẫu dùng `{"topic":"Chủ đề cần viết"}`.
5. Theo dõi lịch sử, trace, các lần review và tải Markdown/TXT/JSON nguyên bản.

Mẫu dùng role `default` cho cả Task/Review để chạy được với cấu hình Worker mặc định. Muốn phân công VM viết và VM review riêng, đổi role của node thành `writer` và `reviewer`, rồi cấu hình `AF_WORKER_ROLES` tương ứng. Role không có Worker phù hợp sẽ nằm chờ.

### Node và input

- **Start**: danh sách trigger, execution defaults và limits cho workflow.
- **Task**: SKILL dạng văn bản, role và template input.
- **Review**: rubric rõ ràng; yêu cầu JSON `{passed:boolean,score:0..100,issues:string[]}`. Không sửa JSON hoặc đoán đạt khi dữ liệu sai.
- **Condition**: case theo thứ tự, nhánh đầu tiên đúng được chọn; cổng cuối là Otherwise. Không có nhánh phù hợp thì tạm dừng.
- **Repeat**: ID node quay lại; `maxIterations` tính cả lượt đầu, mặc định 3. `delaySec` điều chỉnh khoảng chờ giữa các vòng. Mỗi vòng tạo lần thực thi mới.
- **Delay**: `delaySec` hoặc thời điểm ISO `until`; được lưu và khôi phục sau restart.
- **End**: chọn thành công/thất bại và `outputNodeId`. Để trống dùng Task gần nhất còn hợp lệ trong vòng hiện tại, không dùng nhầm JSON review.

Template khả dụng: `{{input}}`, `{{input.topic}}`, `{{lastOutput}}`, `{{steps.NODE_ID.text}}`, `{{feedback}}`, `{{previousOutput}}`, `{{iteration}}`. Input object được serialize JSON khi chèn vào văn bản. Nội dung thay thế không bị trim/HTML escape. Sau Repeat, các kết quả trong đoạn lặp bị vô hiệu hóa; feedback và bản trước chỉ còn qua các biến có tên rõ ràng.

Mỗi workflow chạy một bước tại một thời điểm; nhiều lượt/workflow chạy song song. Không có fork/join trong một lượt v1. Mọi vòng cần Repeat có giới hạn; giới hạn tổng số bước cũng chặn chu kỳ lồng nhau.

### Trigger và lịch

Start nhận JSON `triggers`, ví dụ:

```json
[
  { "id": "manual", "type": "manual" },
  {
    "id": "daily",
    "type": "schedule",
    "cron": "0 8 * * *",
    "timezone": "Asia/Saigon",
    "input": { "topic": "Báo cáo sáng" },
    "overlap": "queue",
    "missed": "skip"
  },
  {
    "id": "incoming",
    "type": "event",
    "eventType": "input.ready",
    "when": { "==": [{ "var": "ready" }, true] }
  },
  {
    "id": "after-A",
    "type": "workflow",
    "sourceWorkflowId": "WORKFLOW_A_ID",
    "when": { "==": [{ "var": "status" }, "succeeded"] }
  }
]
```

Schedule dùng `cron` **hoặc** `intervalSec`; `input` tùy chọn cung cấp dữ liệu cho lịch. Thiếu input thì nhận `scheduledAt`. Điều kiện `when` kiểm tra trên input/payload gốc. Workflow kế tiếp nhận `{workflowId,runId,status,output,review,artifactId}`; dùng `{{input.output}}` để lấy nguyên Output trước.

`overlap`: `queue` hoặc `skip`. `missed`: `skip` hoặc `catchUpLatest`; không phát lại toàn bộ lịch bị lỡ. Thời điểm đến hạn lưu bền vững; event/schedule bị gửi lại không tạo run trùng kể cả khi Publish phiên bản mới. Mọi workflow nối tiếp cùng chia sẻ giới hạn `maxChainRuns`.

### Nhập file hoặc event

```powershell
$env:AF_ADMIN_TOKEN='ADMIN_TOKEN_CUA_MANAGER'
$env:AF_MANAGER_URL='http://PCA:6060'
npx tsx scripts/submit.ts WORKFLOW_ID input.txt
npx tsx scripts/submit.ts WORKFLOW_ID input.json
```

File TXT đọc UTF-8, JSON được parse làm input. Không upload file đính kèm lên ChatGPT; nội dung dựng thành prompt. Toàn bộ SKILL + input + rubric phải trong **150.000 đơn vị UTF-16**; vượt giới hạn thì dừng để sửa, không cắt.

Hệ thống ngoài có thể gửi event có ID ổn định đến `POST /api/v1/events` với admin Bearer token:

```json
{
  "id": "source-job-001",
  "type": "input.ready",
  "payload": { "ready": true, "topic": "Nội dung mới" }
}
```

## Cấu hình thời gian

Dashboard **Cấu hình** cho phép sửa mọi tham số, overrides theo Worker, import/export JSON. Đơn vị là giây.

| Nhóm                                    | Mặc định                               |
| --------------------------------------- | -------------------------------------- |
| Long-poll / HTTP long-poll              | 25 / 35                                |
| API request                             | 30                                     |
| Heartbeat / offline / pre-send lease    | 10 / 30 / 60                           |
| Artifact transfer idle                  | 60                                     |
| Không tiến triển                        | 600                                    |
| Tổng thời gian bước / workflow          | `null` / `null` = tắt                  |
| Hành động timeout                       | `warn`, có thể đổi `pause` hoặc `stop` |
| Đồng thời toàn hệ thống / mỗi workflow  | 2 / 1                                  |
| Run đang chờ mỗi workflow               | 100                                    |
| Tổng lần thực thi bước / chuỗi workflow | 100 / 10                               |

Kết nối kế thừa **hệ thống → Worker**. Execution kế thừa **hệ thống → workflow → node**. Settings execution, graph, SKILL, rubric và input được chụp lúc tạo run. Thay đổi áp dụng cho run mới; heartbeat/network có version và được trao đổi khi kết nối. Trong chuyển tiếp Manager dùng ngưỡng bảo thủ lớn hơn để không báo offline nhầm.

**25 giây long-poll không giới hạn thời gian ChatGPT tạo phản hồi.** Không có deadline tổng 6 phút. Heartbeat và tiến triển độc lập; cấu hình timeout chỉ cảnh báo/tạm dừng/dừng, không tự gửi lại prompt.

## Khôi phục và Output

- Manager và Worker lưu SQLite WAL, synchronous FULL trên ổ cục bộ. Worker ghi `sending` trước xin quyền gửi và trước đúng một thao tác Send.
- Không có Enter fallback, regenerate, retry prompt, đổi tài khoản hoặc đổi nhà cung cấp sau kết quả không rõ.
- Timeout/mất kết nối sau khi có thể đã gửi → `uncertain`. Giữ Worker bận và chỉ đọc lại hội thoại; kết quả hoàn tất có thể đến muộn và được nộp lại bằng cùng ID/hash.
- Sau khi **tự kiểm tra hội thoại**, người vận hành dùng nút đối soát trong trace: `notSent` cho phép attempt mới khi chắc chắn chưa gửi; `abandon` hủy run và giải phóng attempt. Phải ghi lý do kiểm tra; thao tác được audit. Không tự động chọn nhánh này.
- Lỗi chuẩn bị trước khi xin quyền Send báo `notSent`, giải phóng Worker và đặt run `needsReview`. Sửa browser rồi Resume để tạo attempt mới. Review JSON sai/giới hạn vòng lặp cần sửa workflow và tạo run mới, không phát lại run cũ bằng Resume.
- `partial`, token-clipped, `uncertain` và run đã dừng không kích hoạt bước tiếp theo. Raw text/ordered parts và bằng chứng thu thập được giữ lại.
- Markdown được giữ nguyên whitespace, code, citation markup và xuống dòng. TXT chứa cùng byte; JSON download chứa `response`, checksum và kích thước. Raw ordered parts và receipt nằm trong metadata attempt/Worker journal.
- Output hoàn tất hiện được giữ trong journal/ram trước khi upload theo luồng 64KiB; không phải cơ chế stream vô hạn xuống đĩa trong lúc model đang tạo. Không áp cap độ dài Output tùy tiện.

Snapshot VM chỉ thực hiện khi Worker đã dừng; rollback RAM của Worker đang Send không được hỗ trợ. Backup Manager nên dừng cả fleet; phục hồi DB cũ trong khi Worker đang chạy có thể làm mất thông tin phân công và không nằm trong bảo đảm v1.

## Kiểm chứng

```powershell
npm test
npm run check
npm run build
npm run test:e2e
```

Sau build có thể dùng `npm run start:manager` / `npm run start:worker`; build sao chép cả static assets. Để kiểm tra trực tiếp mã đã biên dịch: `node dist/scripts/smoke.js`.

Unit/integration dùng SQLite thật, HTTP thật, Node-RED thật và browser boundary giả lập. Fleet test chạy **10 Worker agents độc lập trên cùng máy**, không phải 10 VM thật. E2E mở Chrome headless vào Manager, tạo/publish workflow, chạy Writer → Review chưa đạt → viết lại → Review đạt, lưu cấu hình và chụp `test-results/manager.png`.

**Chưa xác minh trên tài khoản ChatGPT Free thật hoặc fleet VM thực.** Đầu nối dùng schema/endpoint nội bộ của ChatGPT; thay đổi giao diện/request schema sẽ chuyển job sang trạng thái cần đối soát. Cần pilot với 2 VM thật trước khi mở 5–10 VM. Node22 có cảnh báo experimental cho `node:sqlite`; đó không phải lỗi kiểm thử.

## Nguồn và điều khoản

Mã ứng dụng phát hành MIT. Node-RED có giấy phép Apache-2.0. Browser adapter tái sử dụng/adapt selector và kỹ thuật đọc phiên từ [jeffrey-nz/browser-ai-bridge](https://github.com/jeffrey-nz/browser-ai-bridge) tại commit `de112345daecaf6f2c6d480099de783da7873737`; mã tham chiếu và MIT license trong `vendor/browser-ai-bridge`. Không gọi API upstream có retry hoặc bộ làm sạch Output.

Đây là triển khai nghiên cứu khả năng kỹ thuật. [Điều khoản ChatGPT cá nhân](https://openai.com/policies/terms-of-use/) được kiểm tra trong giai đoạn nghiên cứu có hạn chế tự động trích xuất Output; mã chạy được không đồng nghĩa được phép vận hành. Không triển khai cơ chế vượt CAPTCHA, giả mạo đăng nhập hoặc né hạn mức.
