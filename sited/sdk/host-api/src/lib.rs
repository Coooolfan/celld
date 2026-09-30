//! Host ABI：同步 SQL、可信 HTTP/alarm 事件和有界两段式响应。
//! 数字使用 JavaScript Number 语义。SQL 执行一次，取结果不重复执行。
use serde::{Deserialize, Serialize};
pub use serde_json;
use std::collections::BTreeMap;

#[link(wasm_import_module = "celld_v3")]
extern "C" {
    fn host_log(ptr: *const u8, len: usize);
    fn host_now() -> i64;
    fn host_alarm_set_at(at: i64) -> i32;
    fn host_sql_exec(ptr: *const u8, len: usize) -> i32;
    fn host_sql_take(ptr: *mut u8, cap: usize) -> i32;
    fn host_sql_drop();
}

pub fn log(message: &str) {
    unsafe { host_log(message.as_ptr(), message.len()) }
}
pub fn now() -> i64 {
    unsafe { host_now() }
}

#[derive(Debug)]
pub struct AlarmError(pub String);
impl std::fmt::Display for AlarmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for AlarmError {}
impl From<SqlError> for AlarmError {
    fn from(e: SqlError) -> Self {
        Self(e.to_string())
    }
}
/// 接受事件结束后设置 alarm 的意图；返回成功不表示已经持久化。
pub fn schedule_alarm_at(at: i64) -> Result<(), AlarmError> {
    if !(0..=8_640_000_000_000_000).contains(&at) {
        return Err(AlarmError("invalid alarm timestamp".into()));
    }
    match unsafe { host_alarm_set_at(at) } {
        0 => Ok(()),
        _ => Err(AlarmError("alarm intent rejected".into())),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Number(f64),
    Text(String),
    Blob(Vec<u8>),
}
impl SqlValue {
    pub fn as_number(&self) -> Option<f64> {
        if let Self::Number(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Self::Text(s) = self {
            Some(s)
        } else {
            None
        }
    }
    /// SQL 结果的 JSON 表示；BLOB 为 Base64 对象，不是文本。
    pub fn to_json(&self) -> Result<serde_json::Value, SqlError> {
        use base64::Engine;
        Ok(match self {
            Self::Null => serde_json::Value::Null,
            Self::Number(n) if n.is_finite() && !(*n == 0.0 && n.is_sign_negative()) => {
                serde_json::json!(n)
            }
            Self::Number(_) => {
                return Err(SqlError::value("number cannot be represented by this ABI"))
            }
            Self::Text(s) => serde_json::Value::String(s.clone()),
            Self::Blob(b) => {
                serde_json::json!({"blob": base64::engine::general_purpose::STANDARD.encode(b)})
            }
        })
    }
}
impl From<&str> for SqlValue {
    fn from(s: &str) -> Self {
        Self::Text(s.into())
    }
}
impl From<String> for SqlValue {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}
impl Serialize for SqlValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json()
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for SqlValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use base64::Engine;
        let v = serde_json::Value::deserialize(deserializer)?;
        match v {
            serde_json::Value::Null => Ok(Self::Null),
            serde_json::Value::Number(n) => {
                let n = n
                    .as_f64()
                    .ok_or_else(|| serde::de::Error::custom("invalid number"))?;
                if !n.is_finite() || (n == 0.0 && n.is_sign_negative()) {
                    return Err(serde::de::Error::custom("invalid number"));
                }
                Ok(Self::Number(n))
            }
            serde_json::Value::String(s) => Ok(Self::Text(s)),
            serde_json::Value::Object(o) if o.len() == 1 => {
                let s = o
                    .get("blob")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| serde::de::Error::custom("invalid BLOB"))?;
                let b = base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(serde::de::Error::custom)?;
                Ok(Self::Blob(b))
            }
            _ => Err(serde::de::Error::custom("invalid SQL value")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlQuery {
    pub query: String,
    pub params: Vec<SqlValue>,
}
impl SqlQuery {
    pub fn new(query: &str, params: Vec<SqlValue>) -> Self {
        Self {
            query: query.into(),
            params,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlError {
    pub code: String,
    pub message: String,
    pub query_index: Option<usize>,
}
impl SqlError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            query_index: None,
        }
    }
    fn value(message: &str) -> Self {
        Self::new("VALUE_ERROR", message)
    }
}
impl std::fmt::Display for SqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for SqlError {}

pub mod sql {
    use super::*;
    const MAX_RESULT: usize = 4 * 1024 * 1024;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Reply {
        Success(Success),
        Failure(Failure),
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Success {
        ok: bool,
        results: Vec<SqlResult>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Failure {
        ok: bool,
        error: SqlError,
    }

    pub fn exec(query: &str, params: &[SqlValue]) -> Result<SqlResult, SqlError> {
        Ok(batch(&[SqlQuery::new(query, params.to_vec())])?.remove(0))
    }
    pub fn batch(queries: &[SqlQuery]) -> Result<Vec<SqlResult>, SqlError> {
        if queries.is_empty() || queries.len() > 128 {
            return Err(SqlError::new("INVALID_REQUEST", "expected 1..128 queries"));
        }
        #[derive(Serialize)]
        struct Request<'a> {
            queries: &'a [SqlQuery],
        }
        let bytes = serde_json::to_vec(&Request { queries })
            .map_err(|e| SqlError::value(&e.to_string()))?;
        if bytes.len() > 1024 * 1024 {
            return Err(SqlError::new("INVALID_REQUEST", "SQL request too large"));
        }
        let n = unsafe { host_sql_exec(bytes.as_ptr(), bytes.len()) };
        if n <= 0 || n as usize > MAX_RESULT {
            unsafe { host_sql_drop() };
            return Err(SqlError::new("ABI_ERROR", "invalid SQL result length"));
        }
        let mut output = vec![0; n as usize];
        let written = unsafe { host_sql_take(output.as_mut_ptr(), output.len()) };
        if written != n {
            unsafe { host_sql_drop() };
            return Err(SqlError::new("ABI_ERROR", "incomplete SQL result"));
        }
        let reply: Reply = serde_json::from_slice(&output)
            .map_err(|_| SqlError::new("ABI_ERROR", "invalid SQL reply"))?;
        match reply {
            Reply::Success(r)
                if r.ok
                    && r.results.len() == queries.len()
                    && r.results
                        .iter()
                        .all(|r| r.rows.iter().all(|row| row.len() == r.columns.len())) =>
            {
                Ok(r.results)
            }
            Reply::Failure(r) if !r.ok => Err(r.error),
            _ => Err(SqlError::new("ABI_ERROR", "invalid SQL reply shape")),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    #[serde(skip)]
    pub attempt_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    attempt_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpInput {
    context: Context,
    request: Request,
}
impl Request {
    pub fn route(&self) -> &str {
        self.path
            .split_once('?')
            .map_or(&self.path, |(path, _)| path)
    }
    /// 返回原始 query 编码值。
    pub fn query(&self, key: &str) -> String {
        self.path
            .split_once('?')
            .and_then(|(_, q)| {
                q.split('&').find_map(|pair| {
                    pair.split_once('=')
                        .filter(|(k, _)| *k == key)
                        .map(|(_, v)| v.to_string())
                })
            })
            .unwrap_or_default()
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlarmEvent {
    pub attempt_id: String,
    pub retry_count: u32,
}
pub fn unsupported_alarm(_: AlarmEvent) -> Result<(), AlarmError> {
    Err(AlarmError("alarm handler unsupported".into()))
}
pub fn respond(status: u16, content_type: &str, body: &str) -> String {
    format!("{status}:{content_type}\n{body}")
}
pub fn text(status: u16, body: &str) -> String {
    respond(status, "text/plain", body)
}
pub fn json(status: u16, body: &str) -> String {
    respond(status, "application/json", body)
}
pub fn html(body: &str) -> String {
    respond(200, "text/html", body)
}
pub fn not_found() -> String {
    text(404, "not found")
}

#[doc(hidden)]
pub mod __glue {
    use super::*;
    use std::cell::RefCell;
    thread_local! { static RESPONSE: RefCell<Option<String>> = const { RefCell::new(None) }; }
    /// # Safety
    /// 输入必须由宿主分配且在调用期间有效。
    pub unsafe fn http(ptr: *const u8, len: usize, handler: fn(Request) -> String) -> i32 {
        RESPONSE.with(|r| *r.borrow_mut() = None);
        if ptr.is_null() || len == 0 || len > 2 * 1024 * 1024 {
            return -1;
        }
        let Ok(mut input) =
            serde_json::from_slice::<HttpInput>(core::slice::from_raw_parts(ptr, len))
        else {
            return -1;
        };
        if input.context.attempt_id.is_empty()
            || input.request.method.is_empty()
            || !input.request.path.starts_with('/')
        {
            return -1;
        }
        input.request.attempt_id = input.context.attempt_id;
        let response = handler(input.request);
        if response.len() > 4 * 1024 * 1024 {
            return -1;
        }
        let n = response.len() as i32;
        RESPONSE.with(|r| *r.borrow_mut() = Some(response));
        n
    }
    /// # Safety
    /// 输入必须由宿主分配且在调用期间有效。
    pub unsafe fn alarm(
        ptr: *const u8,
        len: usize,
        handler: fn(AlarmEvent) -> Result<(), AlarmError>,
    ) -> i32 {
        if ptr.is_null() || len == 0 || len > 2 * 1024 * 1024 {
            return -1;
        }
        let Ok(event) = serde_json::from_slice::<AlarmEvent>(core::slice::from_raw_parts(ptr, len))
        else {
            return -1;
        };
        if event.attempt_id.is_empty() {
            return -1;
        }
        match handler(event) {
            Ok(()) => 0,
            Err(_) => -1,
        }
    }
    /// # Safety
    /// out 指向至少 cap 个可写字节。
    pub unsafe fn take(out: *mut u8, cap: usize) -> i32 {
        RESPONSE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(value) = slot.as_ref() else {
                return -1;
            };
            let n = value.len();
            if cap < n {
                return n as i32;
            }
            if n > 0 && out.is_null() {
                return -1;
            }
            core::ptr::copy_nonoverlapping(value.as_ptr(), out, n);
            *slot = None;
            n as i32
        })
    }
}

#[macro_export]
macro_rules! export_abi {
    ($http:path) => {
        $crate::export_abi!($http, $crate::unsupported_alarm);
    };
    ($http:path, $alarm:path) => {
        #[no_mangle]
        pub extern "C" fn abi_version() -> i32 {
            3
        }
        #[no_mangle]
        pub extern "C" fn alloc(len: usize) -> *mut u8 {
            if len == 0 || len > 4 * 1024 * 1024 {
                return core::ptr::null_mut();
            }
            match core::alloc::Layout::from_size_align(len, 1) {
                Ok(layout) => unsafe { std::alloc::alloc(layout) },
                _ => core::ptr::null_mut(),
            }
        }
        #[no_mangle]
        pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
            if !ptr.is_null() && len > 0 {
                if let Ok(layout) = core::alloc::Layout::from_size_align(len, 1) {
                    std::alloc::dealloc(ptr, layout);
                }
            }
        }
        #[no_mangle]
        pub unsafe extern "C" fn handle_http(ptr: *const u8, len: usize) -> i32 {
            $crate::__glue::http(ptr, len, $http)
        }
        #[no_mangle]
        pub unsafe extern "C" fn handle_alarm(ptr: *const u8, len: usize) -> i32 {
            $crate::__glue::alarm(ptr, len, $alarm)
        }
        #[no_mangle]
        pub unsafe extern "C" fn take_response(ptr: *mut u8, cap: usize) -> i32 {
            $crate::__glue::take(ptr, cap)
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values() {
        for v in [
            SqlValue::Null,
            SqlValue::Number(9007199254740991.0),
            SqlValue::Number(1.5),
            SqlValue::Text("'\0中文".into()),
            SqlValue::Blob(vec![0, 255]),
        ] {
            let s = serde_json::to_string(&v).unwrap();
            assert_eq!(serde_json::from_str::<SqlValue>(&s).unwrap(), v);
        }
        for v in [f64::NAN, f64::INFINITY, -0.0] {
            assert!(serde_json::to_string(&SqlValue::Number(v)).is_err());
        }
        for s in ["true", "[]", "{}", "{\"blob\":\"A===\"}"] {
            assert!(serde_json::from_str::<SqlValue>(s).is_err());
        }
    }
}
