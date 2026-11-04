//! Native IPC and filesystem contract; all roots are temporary app-data overrides.
use super::*;
use sha2::{Digest as _, Sha256};
use tauri::{
    test::{mock_builder, MockRuntime, INVOKE_KEY},
    Manager as _,
};

// Capture the actual command future on a test-owned runtime for abort/paused-time
// coverage, without changing the production command or inventing a cancel IPC.
type CommandControl = (
    tokio::runtime::Handle,
    std::sync::Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
);

pub(crate) struct Fixture {
    pub(crate) temp: tempfile::TempDir,
    pub(crate) app: tauri::App<MockRuntime>,
    pub(crate) view: tauri::WebviewWindow<MockRuntime>,
    pub(crate) manager: buzzodz_plugins::Manager,
    pub(crate) revision: String,
}
impl Fixture {
    pub(crate) fn new(managed: bool, files: bool) -> Self {
        Self::configured(
            managed,
            files,
            crate::identity::IdentityHost::fixture(),
            ManagedFiles::default(),
            None,
        )
    }
    fn configured(
        managed: bool,
        files: bool,
        identity: crate::identity::IdentityHost,
        registry: ManagedFiles,
        control: Option<CommandControl>,
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(base.join("registry")), "test", false).unwrap();
        let source = base.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":"example.bytes", "name":"Byte fixture", "apiVersion":1,
            "host":{"managedFiles":managed,"files":files,"networkOrigins":["https://example.test"],
                "processes":[{"id":"read","program":"cat"},{"id":"read-protected","program":"cat"}]}
        })).unwrap()).unwrap();
        let catalog = manager.install(&source).unwrap();
        let revision = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.bytes")
            .unwrap()
            .revision
            .clone();
        manager.change("enable", "example.bytes").unwrap();
        let mut context = crate::app_context();
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(base.clone()),
        );
        let app = mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(crate::host_process::HostProcesses::default())
            .manage(registry)
            .manage(identity)
            .invoke_handler(move |invoke| {
                if let Some((runtime, task)) = &control {
                    if invoke.message.command() == "plugin_host_save_bytes" {
                        use tauri::ipc::CommandArg as _;
                        let job = runtime.spawn(async move {
                            let request =
                                tauri::ipc::Request::from_command(tauri::ipc::CommandItem {
                                    plugin: None,
                                    name: "plugin_host_save_bytes",
                                    key: "request",
                                    message: &invoke.message,
                                    acl: &invoke.acl,
                                })
                                .unwrap();
                            let app = invoke.message.webview().app_handle().clone();
                            let result = plugin_host_save_bytes(
                                app.clone(),
                                app.state::<PluginManager>(),
                                request,
                            )
                            .await;
                            invoke
                                .resolver
                                .respond(result.map_err(tauri::ipc::InvokeError::from));
                        });
                        *task.lock().unwrap() = Some(job);
                        return true;
                    }
                }
                crate::commands()(invoke)
            })
            .build(context)
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            temp,
            app,
            view,
            manager,
            revision,
        }
    }
    pub(crate) fn root(&self) -> PathBuf {
        self.app
            .path()
            .app_data_dir()
            .unwrap()
            .join("plugin-artifacts")
    }
    fn start_ipc(
        &self,
        command: &str,
        body: tauri::ipc::InvokeBody,
        headers: reqwest::header::HeaderMap,
    ) -> std::sync::mpsc::Receiver<tauri::ipc::InvokeResponse> {
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        self.view.as_ref().clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: self.view.url().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_window, _command, response, _callback, _error| {
                let _ = reply.send(response);
            }),
        );
        result
    }
    pub(crate) fn ipc(
        &self,
        command: &str,
        body: tauri::ipc::InvokeBody,
        headers: reqwest::header::HeaderMap,
    ) -> Result<tauri::ipc::InvokeResponseBody, String> {
        let result = self.start_ipc(command, body, headers);
        match result
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("native fixture IPC watchdog")
        {
            tauri::ipc::InvokeResponse::Ok(body) => Ok(body),
            tauri::ipc::InvokeResponse::Err(error) => Err(error.0.to_string()),
        }
    }
    pub(crate) fn save(&self, bytes: &[u8], hash: &str) -> Result<serde_json::Value, String> {
        self.save_policy(bytes, hash, false)
    }
    pub(crate) fn save_policy(
        &self,
        bytes: &[u8],
        hash: &str,
        release: bool,
    ) -> Result<serde_json::Value, String> {
        let mut headers = reqwest::header::HeaderMap::from_iter([
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
                "example.bytes".parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
                self.revision.parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-sha256"),
                hash.parse().unwrap(),
            ),
        ]);
        if release {
            headers.insert("x-buzz-release-after-send", "1".parse().unwrap());
        }
        self.ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
        .map(|r| r.deserialize().unwrap())
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// BYTE_WORK is process-wide, so fixtures that invoke an admitted command serialize.
static COMMANDS: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) fn commands() -> std::sync::MutexGuard<'static, ()> {
    COMMANDS.lock().unwrap()
}

#[test]
fn raw_save_is_private_readable_and_not_implicitly_deduplicated() {
    let _serial = commands();
    let f = Fixture::new(true, true);
    let bytes = [0, 159, 255, 1];
    let hash = digest(&bytes);
    let before = wall_ms().unwrap();
    let saved = f.save(&bytes, &hash).unwrap();
    let path = saved["path"].as_str().unwrap();
    assert_eq!(saved["sha256"], hash);
    assert_eq!(saved["size"], 4);
    assert!(saved["expiresAt"].as_u64().unwrap() >= before + RETENTION_MS);
    assert_eq!(Path::new(path).parent().unwrap(), f.root());
    assert_eq!(
        artifact_expiry(Path::new(path).file_name().unwrap().to_str().unwrap()),
        saved["expiresAt"].as_u64()
    );
    let read = f
        .ipc(
            "plugin_host_read_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":f.revision, "path":path
            })),
            Default::default(),
        )
        .unwrap();
    match read {
        tauri::ipc::InvokeResponseBody::Raw(data) => assert_eq!(data, bytes),
        _ => panic!("expected raw read"),
    }
    let second = f.save(&bytes, &hash).unwrap();
    assert_ne!(saved["path"], second["path"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(f.root()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    f.manager.change("disable", "example.bytes").unwrap();
    assert!(Path::new(path).exists()); // Disable is not erasure.
    assert!(f.save(&bytes, &hash).is_err());
}

#[test]
fn save_grant_does_not_grant_reading_and_fallback_never_creates_storage() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let saved = f.save(b"data", &digest(b"data")).unwrap();
    let error = f
        .ipc(
            "plugin_host_read_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":f.revision, "path":saved["path"]
            })),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("Files are not declared"));
    let f = Fixture::new(false, true);
    assert!(f
        .save(b"data", &digest(b"data"))
        .unwrap_err()
        .contains("not declared"));
    assert!(!f.root().exists());
    let f = Fixture::new(true, false);
    let error = f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Json(serde_json::json!([0, 159, 255])),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("raw bytes"));
    assert!(!f.root().exists());
    assert!(f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(vec![1]),
            Default::default()
        )
        .unwrap_err()
        .contains("metadata"));
    assert!(!f.root().exists());
}

#[test]
fn invalid_input_hash_mismatch_and_deadline_leave_no_published_file() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let hash = digest(b"data");
    for (bytes, hash) in [
        (vec![], hash.clone()),
        (vec![0; MAX_SAVE_BYTES + 1], hash.clone()),
        (vec![1], "A".repeat(64)),
        (vec![1], "0".repeat(63)),
    ] {
        assert!(f.save(&bytes, &hash).unwrap_err().contains("Invalid"));
        assert!(!f.root().exists());
    }
    assert!(f
        .save(b"data", &"0".repeat(64))
        .unwrap_err()
        .contains("mismatch"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1); // Only ownership lock.
    let result = save_managed(ManagedSave {
        root: &f.root(),
        bytes: b"data",
        hash: &hash,
        deadline: std::time::Instant::now(),
        manager: &f.manager,
        id: "example.bytes",
        revision: &f.revision,
        registry: None,
        consent: None,
    });
    assert!(result.err().unwrap().contains("expired"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1);
    assert!(save_managed(ManagedSave {
        root: &f.root(),
        bytes: b"data",
        hash: &hash,
        deadline: std::time::Instant::now() + SAVE_WINDOW,
        manager: &f.manager,
        id: "example.bytes",
        revision: "stale",
        registry: None,
        consent: None,
    })
    .is_err());
}

#[test]
fn capacity_counts_unknown_zero_length_and_partial_files_without_eviction() {
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    for i in 0..ROOT_FILES {
        std::fs::write(f.root().join(format!("unknown-{i}")), []).unwrap();
    }
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("full"));
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), ROOT_FILES + 1);
    std::fs::write(f.root().join("overflow"), []).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("too many"));
    for entry in std::fs::read_dir(f.root()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != LOCK_NAME {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    let partial = f.root().join("unknown-partial");
    let file = std::fs::File::create(&partial).unwrap();
    file.set_len(ROOT_BYTES).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1)
        .unwrap_err()
        .contains("full"));
    assert_eq!(file.metadata().unwrap().len(), ROOT_BYTES);
    file.set_len(ROOT_BYTES - 1).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_ok());
}

#[test]
fn expiry_sweeps_only_strict_host_names_at_the_wall_clock_boundary() {
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    let id = uuid::Uuid::new_v4();
    let expired = f.root().join(format!("100-{id}"));
    let retained = f.root().join(format!("101-{id}"));
    let unknown = f.root().join(format!("0100-{id}"));
    for path in [&expired, &retained, &unknown] {
        std::fs::write(path, [1]).unwrap();
    }
    managed_capacity(&f.root(), 99, 1).unwrap();
    assert!(expired.exists());
    managed_capacity(&f.root(), 100, 1).unwrap();
    assert!(!expired.exists());
    assert!(retained.exists());
    assert!(unknown.exists());
    managed_capacity(&f.root(), 101, 1).unwrap();
    assert!(!retained.exists());
    assert!(unknown.exists());
}

#[test]
fn ownership_lock_rejects_independent_open_and_exclusive_create_never_overwrites() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    assert!(managed_lock(&f.root()).err().unwrap().contains("busy"));
    let path = f.root().join("existing");
    std::fs::write(&path, b"original").unwrap();
    assert!(private_options().create_new(true).open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    drop(lock);
    managed_lock(&f.root()).expect("released root gate must be immediately available");
}

#[cfg(unix)]
#[test]
fn links_public_root_and_unexpected_directories_fail_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt as _};
    let f = Fixture::new(true, false);
    symlink(f.temp.path(), f.root()).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::remove_file(f.root()).unwrap();
    std::fs::create_dir(f.root()).unwrap();
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let lock_path = f.root().join(LOCK_NAME);
    symlink(f.temp.path().join("absent"), &lock_path).unwrap();
    assert!(managed_lock(&f.root()).is_err());
    std::fs::remove_file(&lock_path).unwrap();
    let _lock = managed_lock(&f.root()).unwrap();
    let path = f.root().join("unexpected");
    std::fs::create_dir(&path).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_err());
    std::fs::remove_dir(&path).unwrap();
    symlink(f.temp.path(), &path).unwrap();
    assert!(managed_capacity(&f.root(), 100, 1).is_err());
}

#[test]
fn timed_out_managed_writer_holds_actual_byte_permit_and_root_lock_through_cleanup() {
    // Hold process-wide fixture serialization outside the async task until it completes.
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let f = Fixture::new(true, false);
            let root = f.root();
            let held_root = root.clone();
            let place = BYTE_WORK.try_acquire().unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            let writer = managed_writer(place, move || {
                let _lock = managed_lock(&held_root)?;
                let partial = held_root.join("partial");
                std::fs::write(&partial, b"partial").unwrap();
                started.send(()).unwrap();
                released
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                std::fs::remove_file(partial).unwrap();
                Ok(())
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), ready)
                .await
                .unwrap()
                .unwrap();
            // Already elapsed async deadline; the very same production writer keeps ownership.
            let end = tokio::time::Instant::now();
            assert!(tokio::time::timeout_at(end, writer).await.is_err());
            assert!(BYTE_WORK.try_acquire().is_err());
            assert!(managed_lock(&root).err().unwrap().contains("busy"));
            assert!(root.join("partial").exists());
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if let Ok(permit) = BYTE_WORK.try_acquire() {
                        drop(permit);
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!root.join("partial").exists());
            assert!(managed_lock(&root).is_ok());
        });
}

#[cfg(unix)]
#[test]
fn expired_deletion_failure_stays_counted_and_never_evicts_unknown_files() {
    use std::os::unix::fs::PermissionsExt as _;
    let f = Fixture::new(true, false);
    let _lock = managed_lock(&f.root()).unwrap();
    for _ in 0..ROOT_FILES {
        std::fs::write(f.root().join(format!("100-{}", uuid::Uuid::new_v4())), [1]).unwrap();
    }
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = managed_capacity(&f.root(), 100, 1);
    let count = std::fs::read_dir(f.root()).unwrap().count();
    std::fs::set_permissions(f.root(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.err().unwrap().contains("full"));
    assert_eq!(count, ROOT_FILES + 1);
}

#[test]
fn independent_process_cannot_enter_a_held_root_gate() {
    // A spawned child can inherit another fixture's flock until exec/exit.
    // Keep fork/exec outside other fixtures' immediate post-drop assertions.
    let _serial = commands();
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "host_files::managed_tests::root_gate_child",
            "--nocapture",
        ])
        .env("BUZZ_TEST_MANAGED_ROOT", f.root())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child root gate watchdog");
        }
        std::thread::yield_now();
    };
    assert!(status.success());
    drop(lock);
    assert!(managed_lock(&f.root()).is_ok());
}

#[test]
fn root_gate_child() {
    // Set only by the isolated parent fixture, never application configuration.
    if let Some(root) = std::env::var_os("BUZZ_TEST_MANAGED_ROOT") {
        assert!(managed_lock(Path::new(&root))
            .err()
            .unwrap()
            .contains("busy"));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaveBoundary {
    BeforeWrite,
    PartialWrite,
    FileSync,
    #[cfg(unix)]
    DirectorySync,
    Revoke,
}

fn save_failure_at(boundary: SaveBoundary) {
    use std::io::Write as _;
    let _serial = commands();
    let f = Fixture::new(true, false);
    let root = f.root();
    drop(managed_lock(&root).unwrap());
    let retained = root.join(format!(
        "{}-{}",
        wall_ms().unwrap() + RETENTION_MS,
        uuid::Uuid::new_v4()
    ));
    let unknown = root.join("unknown-sentinel");
    for path in [&retained, &unknown] {
        std::fs::write(path, b"untouched").unwrap();
    }
    let bytes = b"actual-save-bytes";
    let manager = f.manager.clone();
    let revision = f.revision.clone();
    let writer_root = root.clone();
    let place = BYTE_WORK.try_acquire().unwrap();
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let (release, released) = std::sync::mpsc::sync_channel(1);
    // Release on assertion unwind as well; the writer also has its own watchdog.
    struct Release(Option<std::sync::mpsc::SyncSender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let release = Release(Some(release));
    let writer = managed_writer(place, move || {
        let gate = || {
            started.send(()).unwrap();
            released
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        };
        let failure = || std::io::Error::other(format!("injected {boundary:?}"));
        save_managed_with_io(
            ManagedSave {
                root: &writer_root,
                bytes,
                hash: &digest(bytes),
                deadline: std::time::Instant::now() + SAVE_WINDOW,
                manager: &manager,
                id: "example.bytes",
                revision: &revision,
                registry: None,
                consent: None,
            },
            |file, bytes| {
                if boundary == SaveBoundary::BeforeWrite {
                    gate();
                    return Err(failure());
                }
                if boundary == SaveBoundary::PartialWrite {
                    file.write_all(&bytes[..4])?;
                    gate();
                    return Err(failure());
                }
                file.write_all(bytes)?;
                if boundary == SaveBoundary::Revoke {
                    gate();
                }
                Ok(())
            },
            |file| {
                if boundary == SaveBoundary::FileSync {
                    gate();
                    return Err(failure());
                }
                file.sync_all()
            },
            |root| {
                #[cfg(unix)]
                {
                    if boundary == SaveBoundary::DirectorySync {
                        gate();
                        return Err(failure());
                    }
                    std::fs::File::open(root)?.sync_all()?;
                }
                #[cfg(not(unix))]
                let _ = root;
                Ok(())
            },
        )
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("actual save boundary watchdog");
    let entries: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap() != LOCK_NAME && *p != retained && *p != unknown)
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "exclusive actual save file exists at the held boundary"
    );
    let actual = std::fs::read(&entries[0]).unwrap();
    let expected = match boundary {
        SaveBoundary::BeforeWrite => &bytes[..0],
        SaveBoundary::PartialWrite => &bytes[..4],
        _ => &bytes[..],
    };
    assert_eq!(
        actual, expected,
        "inspect real file before operation failure/revocation"
    );
    assert!(BYTE_WORK.try_acquire().is_err());
    assert!(managed_lock(&root).err().unwrap().contains("busy"));
    if boundary == SaveBoundary::Revoke {
        f.manager.change("disable", "example.bytes").unwrap();
    }
    drop(release);
    let result = tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(5), writer).await
    })
    .expect("actual writer completion watchdog")
    .unwrap();
    let error = result
        .err()
        .expect("actual save must refuse SavedBytes/path metadata");
    if boundary == SaveBoundary::Revoke {
        assert!(error.contains("disabled or updated"), "{error}");
    } else {
        assert!(error.contains(&format!("injected {boundary:?}")), "{error}");
    }
    assert!(
        !entries[0].exists(),
        "common failure cleanup must remove the actual save file"
    );
    for path in [&retained, &unknown] {
        assert_eq!(std::fs::read(path).unwrap(), b"untouched");
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 3);
    let _place = BYTE_WORK
        .try_acquire()
        .expect("actual writer released byte admission");
    let _lock = managed_lock(&root).expect("actual writer released filesystem ownership");
    managed_capacity(&root, wall_ms().unwrap(), bytes.len()).unwrap();
}

#[test]
fn actual_save_operation_failures_refuse_and_clean_up_under_writer_ownership() {
    for boundary in [
        SaveBoundary::BeforeWrite,
        SaveBoundary::PartialWrite,
        SaveBoundary::FileSync,
        #[cfg(unix)]
        SaveBoundary::DirectorySync,
    ] {
        save_failure_at(boundary);
    }
}

#[test]
fn actual_save_observes_disable_after_real_write_before_final_eligibility() {
    save_failure_at(SaveBoundary::Revoke);
}

#[test]
fn own_managed_delete_refuses_other_plugins_legacy_paths_and_active_reads() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let saved = f.save(b"owned", &digest(b"owned")).unwrap();
    let path = saved["path"].as_str().unwrap();
    let remove = |path: &str, id: &str| {
        f.ipc(
            "plugin_host_delete_managed_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":id,"revision":f.revision,"path":path
            })),
            Default::default(),
        )
    };
    assert!(remove(path, "other.plugin").is_err());
    // A different enabled plugin with the same capability still has no ownership.
    let source = f.temp.path().join("other-source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    std::fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"other.plugin","name":"Other","apiVersion":1,"host":{"managedFiles":true}
        }))
        .unwrap(),
    )
    .unwrap();
    let catalog = f.manager.install(&source).unwrap();
    let other = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "other.plugin")
        .unwrap();
    f.manager.change("enable", "other.plugin").unwrap();
    let error = f
        .ipc(
            "plugin_host_delete_managed_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"other.plugin","revision":other.revision,"path":path
            })),
            Default::default(),
        )
        .unwrap_err();
    assert!(error.contains("not owned"));
    assert!(delete_managed(&f.root(), path, &f.manager, "example.bytes", "stale", None).is_err());

    assert!(remove(
        f.temp.path().join("outside").to_str().unwrap(),
        "example.bytes"
    )
    .is_err());
    let legacy = f
        .root()
        .join(format!("9999999999999-{}", uuid::Uuid::new_v4()));
    std::fs::write(&legacy, b"legacy").unwrap();
    assert!(remove(legacy.to_str().unwrap(), "example.bytes").is_err());
    // This is the exact shared lease held by the native reader until its byte snapshot completes.
    let lease = FileReadLease::new().unwrap();
    assert!(remove(path, "example.bytes")
        .unwrap_err()
        .contains("in use"));
    assert_eq!(std::fs::read(path).unwrap(), b"owned");
    drop(lease);
    remove(path, "example.bytes").unwrap();
    assert!(!Path::new(path).exists());
    assert!(legacy.exists());
    assert!(remove(path, "example.bytes").is_err());
}

#[test]
fn byte_admission_is_fifo_bounded_and_expired_waiters_release_capacity() {
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
        .block_on(async {
            use std::future::Future;
            use std::task::{Context, Poll, Waker};
            let held = BYTE_WORK.acquire().await.unwrap();
            let end = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
            let mut first = Box::pin(byte_admission(end));
            let mut second = Box::pin(byte_admission(end));
            let mut cx = Context::from_waker(Waker::noop());
            assert!(first.as_mut().poll(&mut cx).is_pending());
            assert!(second.as_mut().poll(&mut cx).is_pending());
            let mut rest = Vec::new();
            for _ in 2..16 {
                let mut waiter = Box::pin(byte_admission(end));
                assert!(waiter.as_mut().poll(&mut cx).is_pending());
                rest.push(waiter);
            }
            assert!(byte_admission(end).await.unwrap_err().contains("queue"));
            drop(held);
            // Polling the second first must not allow it to jump the FIFO queue.
            assert!(second.as_mut().poll(&mut cx).is_pending());
            let Poll::Ready(Ok(permit)) = first.as_mut().poll(&mut cx) else {
                panic!("first waiter not admitted")
            };
            assert!(second.as_mut().poll(&mut cx).is_pending());
            drop(permit);
            let permit = second.await.unwrap();
            tokio::time::advance(std::time::Duration::from_secs(1)).await;
            for waiter in rest {
                assert!(waiter.await.unwrap_err().contains("timed out"));
            }
            drop(permit);
            assert!(byte_admission(end).await.is_err());
            drop(
                byte_admission(tokio::time::Instant::now() + SAVE_WINDOW)
                    .await
                    .unwrap(),
            );
        });
}

#[test]
fn root_gate_unlocks_even_when_another_process_inherits_the_open_description() {
    let f = Fixture::new(true, false);
    let lock = managed_lock(&f.root()).unwrap();
    // try_clone models an inherited descriptor sharing the same flock description.
    let inherited = lock.try_clone().unwrap();
    drop(lock);
    let next =
        managed_lock(&f.root()).expect("guard drop must unlock before the inherited fd closes");
    drop(inherited);
    drop(next);
}

#[test]
fn concurrent_native_saves_queue_instead_of_refusing_the_second_plugin_operation() {
    let _serial = commands();
    let held = BYTE_WORK.try_acquire().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let jobs: Vec<_> = [b"one", b"two"]
        .into_iter()
        .map(|bytes| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let f = Fixture::new(true, false);
                barrier.wait();
                let saved = f.save(bytes, &digest(bytes)).unwrap();
                assert_eq!(
                    std::fs::read(saved["path"].as_str().unwrap()).unwrap(),
                    bytes
                );
                saved
            })
        })
        .collect();
    barrier.wait();
    let watchdog = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while BYTE_WAITERS.available_permits() != 14 {
        assert!(
            std::time::Instant::now() < watchdog,
            "both commands must reach admission"
        );
        std::thread::yield_now();
    }
    drop(held);
    let saved: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    assert_ne!(saved[0]["path"], saved[1]["path"]);
}

#[cfg(unix)]
#[test]
fn process_attachment_reader_blocks_delete_until_output_and_killed_child_complete() {
    let _serial = commands();
    tauri::async_runtime::block_on(async {
        let f = Fixture::new(true, false);
        let saved = f
            .save(b"process-source", &digest(b"process-source"))
            .unwrap();
        let path = saved["path"].as_str().unwrap();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = events.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let handle = crate::host_process::plugin_host_process_spawn(
            f.app.handle().clone(),
            f.app.state(),
            f.app.state(),
            "example.bytes".into(),
            f.revision.clone(),
            "read".into(),
            Vec::new(),
            None,
            None,
            channel,
            None,
            None,
        )
        .await
        .unwrap();
        // cat is held on stdin; its actual monitor owns the admitted reader lease.
        assert!(delete_managed(
            &f.root(),
            path,
            &f.manager,
            "example.bytes",
            &f.revision,
            None
        )
        .unwrap_err()
        .contains("in use"));
        crate::host_process::plugin_host_process_write(
            f.app.state(),
            "example.bytes".into(),
            handle,
            "ready\n".into(),
            false,
        )
        .await
        .unwrap();
        let event = received.recv().await.unwrap();
        assert_eq!(event["type"], "stdout");
        crate::host_process::plugin_host_process_kill(
            f.app.state(),
            "example.bytes".into(),
            handle,
        )
        .unwrap();
        // Kill is a request, not proof of actual completion. Until Exit the lease must not be dropped early.
        while let Some(event) = tokio::time::timeout(SAVE_WINDOW, received.recv())
            .await
            .unwrap()
        {
            if event["type"] == "exit" {
                break;
            }
        }
        delete_managed(
            &f.root(),
            path,
            &f.manager,
            "example.bytes",
            &f.revision,
            None,
        )
        .unwrap();
    });
}

#[test]
fn managed_deletes_queue_behind_a_held_save_and_each_other() {
    use std::io::Write as _;
    let _serial = commands();
    let f = Fixture::new(true, false);
    let paths: Vec<_> = [b"first", b"other"]
        .into_iter()
        .map(|bytes| {
            f.save(bytes, &digest(bytes)).unwrap()["path"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let root = f.root();
    let manager = f.manager.clone();
    let revision = f.revision.clone();
    let place = BYTE_WORK.try_acquire().unwrap();
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let (release, released) = std::sync::mpsc::sync_channel(1);
    // Unwind also releases the held actual write, rather than stranding a worker.
    struct Release(Option<std::sync::mpsc::SyncSender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }
    let release = Release(Some(release));
    let writer = managed_writer(place, move || {
        save_managed_with_io(
            ManagedSave {
                root: &root,
                bytes: b"saving",
                hash: &digest(b"saving"),
                deadline: std::time::Instant::now() + SAVE_WINDOW,
                manager: &manager,
                id: "example.bytes",
                revision: &revision,
                registry: None,
                consent: None,
            },
            |file, bytes| {
                file.write_all(bytes)?;
                started.send(()).unwrap();
                released.recv_timeout(SAVE_WINDOW).unwrap();
                Ok(())
            },
            std::fs::File::sync_all,
            |_| Ok(()),
        )
    });
    ready.recv_timeout(SAVE_WINDOW).unwrap();
    let deletions: Vec<_> = paths
        .iter()
        .map(|path| {
            let view = f.view.clone();
            let body = serde_json::json!({"id":"example.bytes","revision":f.revision,"path":path});
            std::thread::spawn(move || {
                tauri::test::get_ipc_response(
                    &view,
                    tauri::webview::InvokeRequest {
                        cmd: "plugin_host_delete_managed_file".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: view.url().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(body),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.into(),
                    },
                )
                .map_err(|e| e.to_string())
            })
        })
        .collect();
    let watchdog = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while BYTE_WAITERS.available_permits() != 14 {
        assert!(
            !deletions.iter().any(|job| job.is_finished()),
            "delete must queue, not refuse the held root"
        );
        assert!(
            std::time::Instant::now() < watchdog,
            "deletion admission watchdog"
        );
        std::thread::yield_now();
    }
    for path in &paths {
        assert!(Path::new(path).exists());
    }
    drop(release);
    tauri::async_runtime::block_on(writer).unwrap().unwrap();
    for job in deletions {
        job.join().unwrap().unwrap();
    }
    for path in paths {
        assert!(!Path::new(&path).exists());
    }
}

#[test]
fn queued_managed_delete_timeout_never_dispatches_or_reports_unknown_outcome() {
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap()
        .block_on(async {
            let _held = BYTE_WORK.acquire().await.unwrap();
            let dispatched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let seen = dispatched.clone();
            let error =
                delete_with_admission(tokio::time::Instant::now() + SAVE_WINDOW, move || {
                    seen.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap_err();
            assert!(error.contains("not deleted"), "{error}");
            assert!(!error.contains("unknown"), "{error}");
            assert!(!dispatched.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(BYTE_WAITERS.available_permits(), 16);
        });
}

#[test]
fn host_release_reader_admission_refuses_while_exclusion_is_held() {
    let _serial = commands();
    let exclusion = FileReadExclusion::new().unwrap();
    let (send, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        send.send(FileReadLease::new().map(|lease| {
            drop(lease);
        }))
        .unwrap();
    });
    let refused = result.recv_timeout(std::time::Duration::from_secs(1));
    drop(exclusion);
    worker.join().unwrap();
    assert!(refused.is_ok(), "read admission blocked on exclusion");
    assert_eq!(
        refused.unwrap().unwrap_err(),
        "File reads are busy; try again later"
    );
}

#[test]
fn host_release_raw_save_requires_strict_flag_and_native_ack() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let bytes = b"temporary";
    let headers = |value: &str| {
        reqwest::header::HeaderMap::from_iter([
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
                "example.bytes".parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
                f.revision.parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-sha256"),
                digest(bytes).parse().unwrap(),
            ),
            (
                reqwest::header::HeaderName::from_static("x-buzz-release-after-send"),
                value.parse().unwrap(),
            ),
        ])
    };
    assert!(f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(bytes.to_vec()),
            headers("true")
        )
        .is_err());
    let saved: serde_json::Value = f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(bytes.to_vec()),
            headers("1"),
        )
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(saved["releaseAfterSend"], true);
}

#[cfg(unix)]
#[test]
fn host_release_confirmed_attachment_reclaims_only_native_consented_exact_file() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let bytes = b"temporary";
    let hash = digest(bytes);
    let headers = reqwest::header::HeaderMap::from_iter([
        (
            reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
            "example.bytes".parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
            f.revision.parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-sha256"),
            hash.parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-release-after-send"),
            "1".parse().unwrap(),
        ),
    ]);
    let saved: serde_json::Value = f
        .ipc(
            "plugin_host_save_bytes",
            tauri::ipc::InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
        .unwrap()
        .deserialize()
        .unwrap();
    let sibling = f.save(bytes, &hash).unwrap();
    let path = saved["path"].as_str().unwrap();
    let owner =
        tauri::async_runtime::block_on(f.app.state::<crate::identity::IdentityHost>().viewer())
            .unwrap();
    let candidate = serde_json::json!({"path":path, "sha256":hash, "size":bytes.len(), "url":"https://example.test/media"});
    let signed = serde_json::json!({"kind":9,"tags":[["imeta", "url https://example.test/media", format!("x {hash}"),format!("size {}", bytes.len())]]});
    tauri::async_runtime::block_on(release_after_send(
        f.app.state::<ManagedFiles>().inner().clone(),
        f.root(),
        owner,
        signed,
        Some(serde_json::json!([candidate])),
    ));
    assert!(
        !Path::new(path).exists(),
        "confirmed matching source must release"
    );
    assert!(
        Path::new(sibling["path"].as_str().unwrap()).exists(),
        "ordinary saves never adopt consent"
    );
}

struct ReleaseGate(Option<std::sync::mpsc::Sender<()>>);
impl Drop for ReleaseGate {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}
fn managed_gate() -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
    ReleaseGate,
    std::sync::mpsc::Receiver<()>,
) {
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, allowed) = std::sync::mpsc::channel();
    (entered, ready, ReleaseGate(Some(release)), allowed)
}
async fn wait_for_managed_gate(
    ready: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), &'static str> {
    tokio::time::timeout(std::time::Duration::from_secs(10), ready)
        .await
        .map_err(|_| "managed gate was not entered before watchdog")?
        .map_err(|_| "managed gate closed before entry")
}

fn start_release_save(f: &Fixture) -> std::sync::mpsc::Receiver<tauri::ipc::InvokeResponse> {
    let headers = reqwest::header::HeaderMap::from_iter([
        (
            reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
            "example.bytes".parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
            f.revision.parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-sha256"),
            digest(b"fenced").parse().unwrap(),
        ),
        (
            reqwest::header::HeaderName::from_static("x-buzz-release-after-send"),
            "1".parse().unwrap(),
        ),
    ]);
    f.start_ipc(
        "plugin_host_save_bytes",
        tauri::ipc::InvokeBody::Raw(b"fenced".to_vec()),
        headers,
    )
}

#[test]
fn host_release_actual_command_timeout_and_abort_fence_dispatched_save() {
    let _serial = commands();
    for abort in [false, true] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let registry = ManagedFiles::default();
            let task = std::sync::Arc::new(std::sync::Mutex::new(None));
            let identity = crate::identity::IdentityHost::fixture();
            let f = Fixture::configured(
                true,
                false,
                identity,
                registry.clone(),
                Some((tokio::runtime::Handle::current(), task.clone())),
            );
            let (entered, ready, release, allowed) = managed_gate();
            registry.1.lock().unwrap().save = Some((entered, allowed));
            let response = start_release_save(&f);
            wait_for_managed_gate(ready).await.unwrap();
            let job = task.lock().unwrap().take().unwrap();
            assert_eq!(BYTE_WORK.available_permits(), 0);
            if abort {
                job.abort();
                assert!(job.await.unwrap_err().is_cancelled());
            } else {
                tokio::time::pause();
                tokio::time::advance(SAVE_WINDOW + std::time::Duration::from_secs(1)).await;
                job.await.unwrap();
                tokio::time::resume();
                assert!(matches!(
                    response.try_recv().unwrap(),
                    tauri::ipc::InvokeResponse::Err(_)
                ));
            }
            assert!(registry.0.lock().unwrap().is_empty());
            assert_eq!(
                BYTE_WORK.available_permits(),
                0,
                "cancelled waiter must not release actual writer admission"
            );
            drop(release);
            let permit = byte_admission(tokio::time::Instant::now() + SAVE_WINDOW)
                .await
                .unwrap();
            assert!(registry.0.lock().unwrap().is_empty());
            assert_eq!(
                std::fs::read_dir(f.root()).unwrap().count(),
                1,
                "precommit cancellation rolls back file"
            );
            drop(permit);
        });
    }
}

#[test]
fn host_release_identity_close_while_queued_or_at_commit_refuses_without_reassignment() {
    let _serial = commands();
    for queued in [true, false] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let registry = ManagedFiles::default();
            let identity = crate::identity::IdentityHost::fixture();
            let task = std::sync::Arc::new(std::sync::Mutex::new(None));
            let f = Fixture::configured(
                true,
                false,
                identity.clone(),
                registry.clone(),
                Some((tokio::runtime::Handle::current(), task.clone())),
            );
            let held = if queued {
                Some(BYTE_WORK.acquire().await.unwrap())
            } else {
                None
            };
            let (entered, ready, release, allowed) = managed_gate();
            if queued {
                registry.1.lock().unwrap().captured = Some(entered);
            } else {
                registry.1.lock().unwrap().save = Some((entered, allowed));
            }
            let response = start_release_save(&f);
            wait_for_managed_gate(ready).await.unwrap();
            identity.close();
            drop(held);
            drop(release);
            let job = task.lock().unwrap().take().unwrap();
            job.await.unwrap();
            assert!(matches!(
                response.try_recv().unwrap(),
                tauri::ipc::InvokeResponse::Err(_)
            ));
            let permit = byte_admission(tokio::time::Instant::now() + SAVE_WINDOW)
                .await
                .unwrap();
            assert!(registry.0.lock().unwrap().is_empty());
            assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1);
            drop(permit);
            let ordinary = f.start_ipc(
                "plugin_host_save_bytes",
                tauri::ipc::InvokeBody::Raw(b"ordinary".to_vec()),
                reqwest::header::HeaderMap::from_iter([
                    (
                        reqwest::header::HeaderName::from_static("x-buzz-plugin-id"),
                        "example.bytes".parse().unwrap(),
                    ),
                    (
                        reqwest::header::HeaderName::from_static("x-buzz-plugin-revision"),
                        f.revision.parse().unwrap(),
                    ),
                    (
                        reqwest::header::HeaderName::from_static("x-buzz-sha256"),
                        digest(b"ordinary").parse().unwrap(),
                    ),
                ]),
            );
            let job = task.lock().unwrap().take().unwrap();
            job.await.unwrap();
            assert!(
                matches!(
                    ordinary.try_recv().unwrap(),
                    tauri::ipc::InvokeResponse::Ok(_)
                ),
                "ordinary saves remain identity independent"
            );
        });
    }
}

pub(crate) fn release_completion(registry: &ManagedFiles) -> tokio::sync::oneshot::Receiver<()> {
    let (released, complete) = tokio::sync::oneshot::channel();
    registry.1.lock().unwrap().released = Some(released);
    complete
}

pub(crate) fn release_fixture_data(
    f: &Fixture,
    bytes: &[u8],
) -> (serde_json::Value, serde_json::Value, String) {
    let hash = digest(bytes);
    let saved = f.save_policy(bytes, &hash, true).unwrap();
    let hints = serde_json::json!([{"path":saved["path"],"sha256":hash,"size":bytes.len(),"url":"https://example.test/media"}]);
    let event = serde_json::json!({"kind":9,"tags":[["imeta","url https://example.test/media",format!("x {hash}"),format!("size {}",bytes.len())]]});
    let owner =
        tauri::async_runtime::block_on(f.app.state::<crate::identity::IdentityHost>().viewer())
            .unwrap();
    (hints, event, owner)
}

#[test]
fn host_release_deadline_starts_before_first_poll_and_cancelled_queue_never_unlinks() {
    let _serial = commands();
    for cancel in [false, true] {
        let f = Fixture::new(true, false);
        let registry = f.app.state::<ManagedFiles>().inner().clone();
        let (hints, event, owner) = release_fixture_data(&f, b"queued source");
        let path = PathBuf::from(hints[0]["path"].as_str().unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let held = BYTE_WORK.acquire().await.unwrap();
            let cleanup = release_after_send(registry, f.root(), owner, event, Some(hints));
            if cancel {
                let task = tokio::spawn(cleanup);
                // On this current-thread runtime, let cleanup reach its blocked
                // admission await, then observe its bounded waiter reservation.
                tokio::task::yield_now().await;
                assert_eq!(BYTE_WAITERS.available_permits(), 15);
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                tokio::time::pause();
                tokio::time::advance(SAVE_WINDOW + std::time::Duration::from_secs(1)).await;
                // An expired attempt must finish on its first poll, without
                // letting paused time auto-advance through a reset deadline.
                let mut cleanup = Box::pin(cleanup);
                assert!(
                    matches!(
                        futures_util::poll!(&mut cleanup),
                        std::task::Poll::Ready(())
                    ),
                    "expired cleanup must return immediately without a fresh budget"
                );
                tokio::time::resume();
            }
            assert_eq!(BYTE_WAITERS.available_permits(), 16);
            assert!(path.exists());
            drop(held);
            let settled = byte_admission(tokio::time::Instant::now() + SAVE_WINDOW)
                .await
                .unwrap();
            assert!(
                path.exists(),
                "expired/cancelled queued work must not dispatch later"
            );
            drop(settled);
        });
    }
}

#[cfg(unix)]
#[test]
fn host_release_reclaims_more_than_sixteen_sequential_saves_and_byte_capacity() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    for _ in 0..20 {
        let (hints, event, owner) = release_fixture_data(&f, b"one send");
        let path = hints[0]["path"].as_str().unwrap().to_owned();
        tauri::async_runtime::block_on(release_after_send(
            registry.clone(),
            f.root(),
            owner,
            event,
            Some(hints),
        ));
        assert!(!Path::new(&path).exists());
        assert!(registry.0.lock().unwrap().is_empty());
    }
    let bytes = vec![7; MAX_SAVE_BYTES];
    let mut batch = vec![];
    let mut event = serde_json::json!({"kind":9,"tags":[]});
    let mut owner = String::new();
    for _ in 0..4 {
        let (hints, signed, key) = release_fixture_data(&f, &bytes);
        batch.push(hints[0].clone());
        event["tags"]
            .as_array_mut()
            .unwrap()
            .push(signed["tags"][0].clone());
        owner = key;
    }
    assert!(f.save(b"over capacity", &digest(b"over capacity")).is_err());
    tauri::async_runtime::block_on(release_after_send(
        registry.clone(),
        f.root(),
        owner,
        event,
        Some(serde_json::json!(batch)),
    ));
    assert!(registry.0.lock().unwrap().is_empty());
    f.save(&bytes, &digest(&bytes)).unwrap();
}

#[test]
fn host_release_refusal_and_restart_retain_until_explicit_sweep_and_prune() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    let (hints, event, owner) = release_fixture_data(&f, b"retained");
    let path = PathBuf::from(hints[0]["path"].as_str().unwrap());
    let lease = FileReadLease::new().unwrap();
    tauri::async_runtime::block_on(release_after_send(
        registry.clone(),
        f.root(),
        owner.clone(),
        event.clone(),
        Some(hints.clone()),
    ));
    assert!(path.exists());
    drop(lease);
    tauri::async_runtime::block_on(release_after_send(
        ManagedFiles::default(),
        f.root(),
        owner,
        event,
        Some(hints),
    ));
    assert!(path.exists(), "restart map must not adopt consent");
    let expiry = artifact_expiry(path.file_name().unwrap().to_str().unwrap()).unwrap();
    // Immediate retention above and explicit sweep/prune below; no clock is advanced.
    assert!(path.exists());
    assert_eq!(registry.0.lock().unwrap().len(), 1);
    let lock = managed_lock(&f.root()).unwrap();
    managed_capacity(&f.root(), expiry + 1, 1).unwrap();
    registry.prune(&f.root()).unwrap();
    drop(lock);
    assert!(!path.exists());
    assert!(registry.0.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn host_release_stalled_hash_has_one_budget_and_prompt_direct_and_process_read_refusal() {
    let _serial = commands();
    for count in [1, ROOT_FILES] {
        let f = Fixture::new(true, true);
        let registry = f.app.state::<ManagedFiles>().inner().clone();
        let mut candidates = vec![];
        let mut signed = serde_json::json!({"kind":9,"tags":[]});
        let mut owner = String::new();
        for _ in 0..count {
            let (hints, event, key) = release_fixture_data(&f, b"hash gate");
            candidates.push(hints[0].clone());
            signed["tags"]
                .as_array_mut()
                .unwrap()
                .push(event["tags"][0].clone());
            owner = key;
        }
        let path = candidates[0]["path"].as_str().unwrap().to_owned();
        let root = f.root();
        let (entered, ready, release, allowed) = managed_gate();
        registry.1.lock().unwrap().hash = Some((entered, allowed));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let cleanup = tokio::spawn(release_after_send(registry.clone(), root, owner, signed, Some(serde_json::json!(candidates))));
            wait_for_managed_gate(ready).await.unwrap();
            let direct = plugin_host_read_file(f.app.state::<PluginManager>(), "example.bytes".into(), f.revision.clone(), path.clone(), None);
            assert!(matches!(futures_util::poll!(Box::pin(direct)), std::task::Poll::Ready(Err(error)) if error == "File reads are busy; try again later"));
            for process in ["read", "read-protected"] {
                let reader = crate::host_process::plugin_host_process_spawn(
                    f.app.handle().clone(), f.app.state::<PluginManager>(), f.app.state::<crate::host_process::HostProcesses>(),
                    "example.bytes".into(), f.revision.clone(), process.into(), vec![path.clone()], None, None,
                    tauri::ipc::Channel::new(|_| panic!("refused process emitted output")), None, None,
                );
                assert!(matches!(futures_util::poll!(Box::pin(reader)), std::task::Poll::Ready(Err(error)) if error == "File reads are busy; try again later"));
            }
            tokio::time::pause();
            let timer = tokio::spawn(async { tokio::time::sleep(std::time::Duration::from_secs(1)).await; });
            tokio::time::advance(SAVE_WINDOW + std::time::Duration::from_secs(1)).await;
            timer.await.unwrap();
            cleanup.await.unwrap();
            tokio::time::resume();
            assert!(Path::new(&path).exists());
            assert_eq!(BYTE_WORK.available_permits(), 0);
            assert!(FileReadExclusion::new().is_err(), "actual hash still owns exclusion after waiter timeout");
            let mut writer = Box::pin(byte_admission(tokio::time::Instant::now() + SAVE_WINDOW));
            assert!(matches!(futures_util::poll!(&mut writer), std::task::Poll::Pending));
            drop(release);
            let permit = writer.await.unwrap();
            assert!(!Path::new(&path).exists());
            // Undispatched later candidates stop at the same elapsed budget.
            if count > 1 { assert_eq!(registry.0.lock().unwrap().len(), count - 1); }
            drop(permit);
            assert!(FileReadLease::new().is_ok());
        });
    }
}

#[test]
fn host_release_rejects_forged_owner_content_paths_metadata_and_replaced_files() {
    let _serial = commands();
    let cases = [
        "owner",
        "hash",
        "size",
        "url",
        "split-imeta",
        "kind",
        "outside",
        "alias",
        "relative",
        "unknown-field",
        "oversized",
        "replaced",
        "content",
        "hardlink",
        "symlink",
        "nonprivate",
    ];
    for case in cases {
        let f = Fixture::new(true, false);
        let registry = f.app.state::<ManagedFiles>().inner().clone();
        let (mut hints, mut signed, mut owner) = release_fixture_data(&f, b"private source");
        let path = PathBuf::from(hints[0]["path"].as_str().unwrap());
        let mut held_original = None;
        match case {
            "owner" => owner = "b".repeat(64),
            "hash" => hints[0]["sha256"] = "0".repeat(64).into(),
            "size" => hints[0]["size"] = 1.into(),
            "url" => hints[0]["url"] = "https://different.test/media".into(),
            "split-imeta" => {
                signed["tags"] = serde_json::json!([
                    ["imeta", "url https://example.test/media"],
                    [
                        "imeta",
                        format!("x {}", digest(b"private source")),
                        "size 14"
                    ]
                ])
            }
            "kind" => signed["kind"] = 1.into(),
            "outside" => hints[0]["path"] = f.temp.path().join("outside").to_str().unwrap().into(),
            "alias" => {
                hints[0]["path"] = format!(
                    "{}/../plugin-artifacts/{}",
                    f.root().display(),
                    path.file_name().unwrap().to_str().unwrap()
                )
                .into()
            }
            "relative" => hints[0]["path"] = path.file_name().unwrap().to_str().unwrap().into(),
            "unknown-field" => hints[0]["owner"] = owner.clone().into(),
            "oversized" => hints = serde_json::json!(vec![hints[0].clone(); ROOT_FILES + 1]),
            "replaced" => {
                held_original = Some(std::fs::File::open(&path).unwrap());
                std::fs::remove_file(&path).unwrap();
                use std::io::Write as _;
                private_options()
                    .create_new(true)
                    .open(&path)
                    .unwrap()
                    .write_all(b"private source")
                    .unwrap();
            }
            "content" => std::fs::write(&path, b"changed source").unwrap(),
            #[cfg(unix)]
            "hardlink" => std::fs::hard_link(&path, f.temp.path().join("alias")).unwrap(),
            #[cfg(unix)]
            "symlink" => {
                std::fs::rename(&path, f.temp.path().join("original")).unwrap();
                std::os::unix::fs::symlink(f.temp.path().join("original"), &path).unwrap();
            }
            #[cfg(unix)]
            "nonprivate" => {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            _ => continue,
        }
        tauri::async_runtime::block_on(release_after_send(
            registry.clone(),
            f.root(),
            owner,
            signed,
            Some(hints),
        ));
        assert!(path.exists(), "{case} must not authorize deletion");
        assert_eq!(
            registry.0.lock().unwrap().len(),
            1,
            "{case} must not discard consent"
        );
        drop(held_original);
    }
}

#[cfg(unix)]
#[test]
fn host_release_committed_consent_survives_saver_disable_and_later_identity_close() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    let (hints, event, owner) = release_fixture_data(&f, b"committed");
    let path = hints[0]["path"].as_str().unwrap().to_owned();
    f.manager.change("disable", "example.bytes").unwrap();
    f.app.state::<crate::identity::IdentityHost>().close();
    tauri::async_runtime::block_on(release_after_send(
        registry,
        f.root(),
        owner,
        event,
        Some(hints),
    ));
    assert!(
        !Path::new(&path).exists(),
        "committed owner is not current UI identity or runtime plugin grant"
    );
}

#[test]
fn host_release_parallel_reader_counter_never_refuses_without_cleanup_exclusion() {
    let _serial = commands();
    let start = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut jobs = vec![];
    for _ in 0..8 {
        let start = start.clone();
        jobs.push(std::thread::spawn(move || {
            start.wait();
            for _ in 0..10_000 {
                let first = FileReadLease::new()
                    .expect("ordinary read contention is not cleanup exclusion");
                let second = FileReadLease::new().expect("parallel readers must coexist");
                drop(first);
                drop(second);
            }
        }));
    }
    let results: Vec<_> = jobs.into_iter().map(|job| job.join()).collect();
    assert!(results.iter().all(Result::is_ok));
}

#[test]
fn host_release_reader_and_exclusion_races_are_mutually_exclusive_and_unwind_safe() {
    let _serial = commands();
    for reader_wins in [true, false] {
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, allowed) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            if reader_wins {
                let _lease = FileReadLease::new().unwrap();
                entered.send(()).unwrap();
                allowed.recv().unwrap();
            } else {
                let _exclusion = FileReadExclusion::new().unwrap();
                entered.send(()).unwrap();
                allowed.recv().unwrap();
            }
        });
        ready.recv().unwrap();
        if reader_wins {
            assert!(FileReadExclusion::new().is_err());
        } else {
            assert!(FileReadLease::new().is_err());
        }
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(FILE_READS.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    for reader in [true, false] {
        let panic = std::panic::catch_unwind(|| {
            if reader {
                let _lease = FileReadLease::new().unwrap();
                panic!("reader unwind");
            } else {
                let _exclusion = FileReadExclusion::new().unwrap();
                panic!("writer unwind");
            }
        });
        assert!(panic.is_err());
        assert_eq!(FILE_READS.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(FileReadExclusion::new().is_ok());
        assert!(FileReadLease::new().is_ok());
    }
}

#[cfg(unix)]
#[test]
fn host_release_duplicate_parallel_and_public_delete_paths_are_single_use() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    let (hints, signed, owner) = release_fixture_data(&f, b"once");
    let path = hints[0]["path"].as_str().unwrap().to_owned();
    let duplicates = serde_json::json!([hints[0].clone(), hints[0].clone()]);
    assert_eq!(
        confirmed_candidates(&signed, Some(duplicates.clone())).len(),
        1
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let first = release_after_send(
            registry.clone(),
            f.root(),
            owner.clone(),
            signed.clone(),
            Some(duplicates),
        );
        let second = release_after_send(
            registry.clone(),
            f.root(),
            owner.clone(),
            signed.clone(),
            Some(hints.clone()),
        );
        tokio::join!(first, second);
        assert!(!Path::new(&path).exists());
        assert!(read(&path, None).unwrap_err().contains("No such file"));
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(
            delete_managed(
                &f.root(),
                &path,
                &f.manager,
                "example.bytes",
                &f.revision,
                Some(&registry)
            )
            .is_err(),
            "public missing-file behavior unchanged"
        );
    });
    let (hints, signed, owner) = release_fixture_data(&f, b"public first");
    let path = hints[0]["path"].as_str().unwrap();
    delete_managed(
        &f.root(),
        path,
        &f.manager,
        "example.bytes",
        &f.revision,
        Some(&registry),
    )
    .unwrap();
    assert!(registry.0.lock().unwrap().is_empty());
    tauri::async_runtime::block_on(release_after_send(
        registry,
        f.root(),
        owner,
        signed,
        Some(hints),
    ));
}

#[cfg(unix)]
#[test]
fn host_release_missing_consent_prunes_on_save_and_one_bad_candidate_keeps_later_safe_work() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    let (mut first, signed, owner) = release_fixture_data(&f, b"matching");
    let first_path = first[0]["path"].as_str().unwrap().to_owned();
    std::fs::remove_file(&first_path).unwrap();
    let (second, _, _) = release_fixture_data(&f, b"matching");
    assert_eq!(
        registry.0.lock().unwrap().len(),
        1,
        "new save prunes missing record"
    );
    first[0]["path"] = first_path.into();
    let batch = serde_json::json!([first[0].clone(), second[0].clone()]);
    tauri::async_runtime::block_on(release_after_send(
        registry.clone(),
        f.root(),
        owner,
        signed,
        Some(batch),
    ));
    assert!(!Path::new(second[0]["path"].as_str().unwrap()).exists());
    assert!(registry.0.lock().unwrap().is_empty());
}

#[test]
fn host_release_identity_and_consent_busy_refuse_without_true_ack_or_adoption() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let registry = f.app.state::<ManagedFiles>().inner().clone();
    let identity = f
        .app
        .state::<crate::identity::IdentityHost>()
        .inner()
        .clone();
    let owner = tauri::async_runtime::block_on(identity.viewer()).unwrap();
    let eligibility = SaveEligibility::default();
    let consent = SaveConsent {
        identity,
        owner,
        registry: registry.clone(),
        eligibility: eligibility.0.clone(),
    };
    let held_map = registry.0.lock().unwrap();
    let result = save_managed(ManagedSave {
        root: &f.root(),
        bytes: b"busy",
        hash: &digest(b"busy"),
        deadline: std::time::Instant::now() + SAVE_WINDOW,
        manager: &f.manager,
        id: "example.bytes",
        revision: &f.revision,
        registry: None,
        consent: Some(&consent),
    });
    assert!(result.is_err());
    assert!(held_map.is_empty());
    drop(held_map);
    assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 1);
    let closed = Fixture::configured(
        true,
        false,
        crate::identity::IdentityHost::fixture_without_key(false),
        ManagedFiles::default(),
        None,
    );
    assert!(closed
        .save_policy(b"closed", &digest(b"closed"), true)
        .is_err());
    assert!(
        !closed.root().exists(),
        "unavailable initial identity refuses before creation"
    );
    assert!(closed.save(b"ordinary", &digest(b"ordinary")).is_ok());
}

#[test]
fn host_release_lost_renderer_waiter_is_not_native_command_cancellation() {
    let _serial = commands();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let registry = ManagedFiles::default();
        let task = std::sync::Arc::new(std::sync::Mutex::new(None));
        let f = Fixture::configured(
            true,
            false,
            crate::identity::IdentityHost::fixture(),
            registry.clone(),
            Some((tokio::runtime::Handle::current(), task.clone())),
        );
        let (entered, ready, release, allowed) = managed_gate();
        registry.1.lock().unwrap().save = Some((entered, allowed));
        let reply = start_release_save(&f);
        wait_for_managed_gate(ready).await.unwrap();
        drop(reply); // The native future remains alive: no cancel IPC exists.
        drop(release);
        let job = task.lock().unwrap().take().unwrap();
        job.await.unwrap();
        assert_eq!(
            registry.0.lock().unwrap().len(),
            1,
            "lost renderer reply can still commit native consent"
        );
        let path = registry.0.lock().unwrap().keys().next().unwrap().clone();
        assert!(path.exists());
        f.app.state::<crate::identity::IdentityHost>().close();
        assert_eq!(
            registry.0.lock().unwrap().len(),
            1,
            "later identity close does not erase or reassign committed consent"
        );
    });
}
