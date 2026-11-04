use buzzodz_plugins::{bundled_manifests, sign_release, Manager};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder as _};
use nostr::key::SecretKey;
use std::{fs, path::PathBuf};

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut encoded = vec![];
    PngEncoder::new(&mut encoded)
        .write_image(
            &vec![0; width as usize * height as usize * 4],
            width,
            height,
            ExtendedColorType::Rgba8,
        )
        .unwrap();
    encoded
}
fn install_error(manager: &Manager, source: &std::path::Path) -> String {
    match manager.install(source) {
        Ok(_) => panic!("installation should fail"),
        Err(error) => error,
    }
}
fn decode_content_icon(encoded: Option<&str>) -> Option<Vec<u8>> {
    use base64::Engine as _;
    encoded.map(|value| {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .unwrap()
    })
}

fn jpg(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![];
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .write_image(
            &vec![128; width as usize * height as usize * 3],
            width,
            height,
            ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes
}

#[test]
fn both_signed_icon_formats_survive_reload_restart_and_rollback() {
    let (temp, manager, source) = fixture();
    let key = SecretKey::generate().to_secret_hex();
    let png_bytes = png(1, 1);
    let first_jpg = jpg(2, 1);
    fs::write(source.join("icon.png"), &png_bytes).unwrap();
    fs::write(source.join("icon.jpg"), &first_jpg).unwrap();
    sign_release(&source, &key).unwrap();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    let content = manager.content("example.page", &first.revision).unwrap();
    assert_eq!(
        decode_content_icon(content.icon_png.as_deref()).as_deref(),
        Some(png_bytes.as_slice())
    );
    assert_eq!(
        decode_content_icon(content.icon_jpg.as_deref()).as_deref(),
        Some(first_jpg.as_slice())
    );
    assert!(first.icon_jpg_revision.is_some());
    let serialized = serde_json::to_value(&content).unwrap();
    assert!(serialized["iconPng"].is_string());
    assert!(serialized["iconJpg"].is_string());
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(temp.path().join("profiles/test/registry.json")).unwrap())
            .unwrap();
    let entry = &registry["installed"]["example.page"];
    assert!(entry.get("readmeRevision").is_none());
    assert!(entry.get("iconRevision").is_none());
    assert!(entry["iconPngRevision"].is_string());
    assert!(entry["iconJpgRevision"].is_string());

    fs::write(source.join("icon.jpg"), jpg(1, 2)).unwrap();
    sign_release(&source, &key).unwrap();
    let second = manager
        .reload("example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(first.icon_jpg_revision, second.icon_jpg_revision);
    assert_eq!(first.icon_png_revision, second.icon_png_revision);
    assert_eq!(first.publisher, second.publisher);

    // A different, valid JPEG still fails the signature check when substituted.
    let mut artifact: serde_json::Value =
        serde_json::from_slice(&fs::read(source.join("plugin.artifact.json")).unwrap()).unwrap();
    use base64::Engine as _;
    artifact["iconJpg"] =
        serde_json::json!(base64::engine::general_purpose::STANDARD.encode(&first_jpg));
    fs::write(
        source.join("plugin.artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    assert!(install_error(&manager, &source).contains("plugin release x tag"));

    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let rolled_back = reopened
        .change("rollback", "example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_eq!(rolled_back.icon_jpg_revision, first.icon_jpg_revision);
    let content = reopened.content("example.page", &first.revision).unwrap();
    assert_eq!(
        decode_content_icon(content.icon_jpg.as_deref()).as_deref(),
        Some(first_jpg.as_slice())
    );
    assert_eq!(
        decode_content_icon(content.icon_png.as_deref()).as_deref(),
        Some(png_bytes.as_slice())
    );
}

#[test]
fn jpeg_only_packages_validate_type_decode_and_resource_bounds() {
    let (_temp, manager, source) = fixture();
    let bytes = jpg(1, 1);
    fs::write(source.join("icon.jpg"), &bytes).unwrap();
    let plugin = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    let content = manager.content("example.page", &plugin.revision).unwrap();
    assert!(content.icon_png.is_none());
    assert_eq!(
        decode_content_icon(content.icon_jpg.as_deref()).as_deref(),
        Some(bytes.as_slice())
    );
    for (bytes, expected) in [
        (png(1, 1), "JPEG"),
        (vec![0xff, 0xd8, 0xff, 0xe0], "valid JPEG"),
        (vec![0; 1024 * 1024 + 1], "size limit"),
        (jpg(4097, 1), "dimensions"),
        (jpg(1025, 1024), "1,048,576"),
    ] {
        fs::write(source.join("icon.jpg"), bytes).unwrap();
        assert!(
            install_error(&manager, &source).contains(expected),
            "{expected}"
        );
    }
}
fn fixture() -> (tempfile::TempDir, Manager, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let source = temp.path().join("build");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    (temp, manager, source)
}
#[test]
fn install_enable_update_rollback_and_remove_survive_restart() {
    let (temp, manager, source) = fixture();
    let catalog = manager.install(&source).unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    let first = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert!(manager.module("example.page", &first).is_err());
    manager.change("enable", "example.page").unwrap();
    fs::write(source.join("plugin.js"), "export const second = true;").unwrap();
    let next = manager.install(&source).unwrap();
    assert!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert_eq!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .previous
            .as_deref(),
        Some(first.as_str())
    );
    assert!(manager.module("example.page", &first).is_err());
    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    assert_eq!(
        reopened
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision
    );
    reopened.change("rollback", "example.page").unwrap();
    assert!(reopened
        .module("example.page", &first)
        .unwrap()
        .contains("apply"));
    reopened.change("remove", "example.page").unwrap();
    assert_eq!(
        reopened.catalog().unwrap().plugins.len(),
        bundled_manifests().len()
    );
}

#[test]
fn readme_and_icon_are_versioned_read_on_demand_and_preserved_by_rollback() {
    let (temp, manager, source) = fixture();
    let first_icon = png(2, 1);
    fs::write(source.join("README.md"), "# First\n").unwrap();
    fs::write(source.join("icon.png"), &first_icon).unwrap();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert!(first.readme_revision.is_some());
    assert!(first.icon_png_revision.is_some());
    let content = manager.content("example.page", &first.revision).unwrap();
    assert_eq!(content.readme.as_deref(), Some("# First\n"));
    assert_eq!(
        decode_content_icon(content.icon_png.as_deref()).as_deref(),
        Some(first_icon.as_slice())
    );

    let second_icon = png(1, 2);
    fs::write(source.join("README.md"), "# Second\n").unwrap();
    fs::write(source.join("icon.png"), &second_icon).unwrap();
    let second = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert_ne!(second.readme_revision, first.readme_revision);
    assert_ne!(second.icon_png_revision, first.icon_png_revision);
    assert!(manager.content("example.page", &first.revision).is_err());

    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let rolled_back = reopened
        .change("rollback", "example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert_eq!(rolled_back.revision, first.revision);
    assert_eq!(rolled_back.readme_revision, first.readme_revision);
    assert_eq!(rolled_back.icon_png_revision, first.icon_png_revision);
    let content = reopened
        .content("example.page", &rolled_back.revision)
        .unwrap();
    assert_eq!(content.readme.as_deref(), Some("# First\n"));
    assert_eq!(
        decode_content_icon(content.icon_png.as_deref()).as_deref(),
        Some(first_icon.as_slice())
    );
}

#[test]
fn package_assets_are_optional_and_reject_invalid_boundaries() {
    let (_temp, manager, source) = fixture();
    let installed = manager.install(&source).unwrap();
    let plugin = installed
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert_eq!(plugin.readme_revision, None);
    assert_eq!(plugin.icon_png_revision, None);
    let content = manager.content("example.page", &plugin.revision).unwrap();
    assert!(content.readme.is_none());
    assert!(content.icon_png.is_none());
    let registry: serde_json::Value = serde_json::from_slice(
        &fs::read(_temp.path().join("profiles/test/registry.json")).unwrap(),
    )
    .unwrap();
    let entry = &registry["installed"]["example.page"];
    for key in ["readmeRevision", "iconPngRevision", "iconJpgRevision"] {
        assert!(entry.get(key).is_none(), "{key}");
    }

    fs::write(source.join("README.md"), [0xff]).unwrap();
    assert!(install_error(&manager, &source).contains("UTF-8"));
    fs::write(source.join("README.md"), vec![b'x'; 256 * 1024 + 1]).unwrap();
    assert!(install_error(&manager, &source).contains("size limit"));
    fs::remove_file(source.join("README.md")).unwrap();

    fs::write(source.join("icon.png"), b"not a png").unwrap();
    assert!(install_error(&manager, &source).contains("PNG"));
    let mut corrupt = b"\x89PNG\r\n\x1a\n".to_vec();
    corrupt.extend_from_slice(b"broken");
    fs::write(source.join("icon.png"), corrupt).unwrap();
    assert!(install_error(&manager, &source).contains("valid PNG"));
    fs::write(source.join("icon.png"), vec![0; 1024 * 1024 + 1]).unwrap();
    assert!(install_error(&manager, &source).contains("size limit"));
    fs::write(source.join("icon.png"), png(4097, 1)).unwrap();
    assert!(install_error(&manager, &source).contains("dimensions"));
    fs::write(source.join("icon.png"), png(1025, 1024)).unwrap();
    assert!(install_error(&manager, &source).contains("1,048,576"));
}

#[test]
fn signed_asset_updates_keep_publisher_and_detect_tampering() {
    let (_temp, manager, source) = fixture();
    let key = SecretKey::generate().to_secret_hex();
    fs::write(source.join("README.md"), "signed first").unwrap();
    fs::write(source.join("icon.png"), png(1, 1)).unwrap();
    let publisher = sign_release(&source, &key).unwrap();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert_eq!(first.publisher.as_deref(), Some(publisher.as_str()));

    fs::write(source.join("README.md"), "signed second").unwrap();
    fs::write(source.join("icon.png"), png(2, 1)).unwrap();
    assert_eq!(sign_release(&source, &key).unwrap(), publisher);
    let second = manager
        .install(&source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    assert_eq!(second.publisher.as_deref(), Some(publisher.as_str()));
    assert_ne!(second.readme_revision, first.readme_revision);
    assert_ne!(second.icon_png_revision, first.icon_png_revision);

    let mut artifact: serde_json::Value =
        serde_json::from_slice(&fs::read(source.join("plugin.artifact.json")).unwrap()).unwrap();
    artifact["readme"] = serde_json::json!("tampered");
    fs::write(
        source.join("plugin.artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    assert!(install_error(&manager, &source).contains("Invalid or ambiguous plugin release x tag"));

    let rolled_back = manager
        .change("rollback", "example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap();
    let content = manager
        .content("example.page", &rolled_back.revision)
        .unwrap();
    assert_eq!(content.readme.as_deref(), Some("signed first"));
}
#[test]
fn folder_reload_updates_current_revision_and_preserves_disabled_state() {
    let (_temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    fs::write(source.join("plugin.js"), "export const reloaded = true;").unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert!(!plugin.enabled);
    assert!(plugin.reloadable);
    assert_ne!(plugin.revision, first);
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    manager.change("enable", "example.page").unwrap();
    assert!(manager
        .module("example.page", &plugin.revision)
        .unwrap()
        .contains("reloaded"));
}
#[test]
fn live_reload_preserves_enabled_state_and_rejects_stale_module_reads() {
    let (_temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    let first = manager
        .change("enable", "example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    fs::write(source.join("plugin.js"), "export const reloaded = true;").unwrap();
    let next = manager
        .reload_live("example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert!(next.enabled);
    assert_ne!(next.revision, first.revision);
    assert_eq!(next.previous.as_deref(), Some(first.revision.as_str()));
    assert!(manager.module("example.page", &first.revision).is_err());
    assert!(manager
        .module("example.page", &next.revision)
        .unwrap()
        .contains("reloaded"));
}

#[test]
fn accepting_reload_permissions_does_not_accept_a_different_publisher() {
    let (_temp, manager, source) = fixture();
    sign_release(&source, &SecretKey::generate().to_secret_hex()).unwrap();
    manager.install(&source).unwrap();
    let first = manager.change("enable", "example.page").unwrap();
    fs::write(source.join("plugin.js"), "export const changed = true;").unwrap();
    sign_release(&source, &SecretKey::generate().to_secret_hex()).unwrap();
    assert!(manager
        .reload_live("example.page")
        .err()
        .unwrap()
        .contains("Publisher changed"));
    let after = manager.catalog().unwrap();
    let plugin = |catalog: buzzodz_plugins::Catalog| {
        catalog
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
    };
    assert_eq!(plugin(first).revision, plugin(after).revision);
}

#[test]
fn folder_reload_compares_effective_output_limits() {
    for (before, after, allowed) in [
        (None, Some(4096), true),
        (Some(4096), None, true),
        (None, Some(65536), false),
        (Some(4096), Some(65536), false),
        (Some(65536), None, false),
        (Some(65536), Some(4096), false),
    ] {
        let (temp, manager, source) = fixture();
        let write_manifest = |limit: Option<u64>| {
            let mut manifest = serde_json::json!({
                "id": "example.page", "name": "Example", "apiVersion": 1,
                "host": {"commands": [{"id": "tools", "program": "agent-tools", "args": ["list", "--json"]}]}
            });
            if let Some(limit) = limit {
                manifest["host"]["commands"][0]["maxOutputBytes"] = serde_json::json!(limit);
            }
            fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
        };
        write_manifest(before);
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        write_manifest(after);
        let result = manager.reload("example.page");
        if allowed {
            assert!(
                result.is_ok(),
                "{before:?} -> {after:?}: {}",
                result.err().unwrap()
            );
        } else {
            assert!(result.err().unwrap().contains("Host access changed"));
        }
        let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let plugin = reopened
            .catalog()
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        assert!(!plugin.enabled);
        assert!(plugin.reloadable);
        assert_eq!(
            plugin.manifest.host.as_ref().unwrap().commands[0].max_output_bytes,
            if allowed { after } else { before }
        );
        if allowed {
            assert_ne!(plugin.revision, first.revision);
            assert_eq!(plugin.previous.as_deref(), Some(first.revision.as_str()));
        } else {
            assert_eq!(plugin.revision, first.revision);
            assert_eq!(plugin.previous, first.previous);
        }
    }
}

#[test]
fn reload_rejects_invalid_sources_without_changing_revision() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert!(manager.reload("buzz.channels").is_err());
    assert!(manager.reload("missing.page").is_err());
    manager.change("enable", "example.page").unwrap();
    assert!(manager.reload("example.page").is_err());
    manager.change("disable", "example.page").unwrap();
    fs::remove_file(source.join("plugin.js")).unwrap();
    assert!(manager.reload("example.page").is_err());
    fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.other","name":"Other","apiVersion":1}"#,
    )
    .unwrap();
    assert!(manager.reload("example.page").is_err());
    assert_eq!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        first
    );
    assert!(std::fs::write(
        temp.path().join("profiles/test/registry.json"),
        r#"{"version":1,"bundledEnabled":true,"bundledOverrides":{},"installed":{"example.page":{"manifest":{"id":"example.page","name":"Example","apiVersion":1},"current":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","currentSource":{"root":"/tmp","path":"../escape"},"previous":null,"enabled":false}}}"#
    )
    .is_ok());
    assert!(manager.reload("example.page").is_err());
}
#[test]
fn reload_rejects_nonconforming_reserved_asset_until_source_migrates() {
    let (_temp, manager, source) = fixture();
    let installed = |manager: &Manager| {
        manager
            .catalog()
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
    };
    manager.install(&source).unwrap();
    let first = installed(&manager);
    // Older hosts ignored this filename; it is now a reserved package asset.
    fs::write(source.join("icon.png"), png(2048, 2048)).unwrap();
    let Err(error) = manager.reload("example.page") else {
        panic!("reload should reject the nonconforming icon");
    };
    assert!(error.contains("icon.png"), "{error}");
    assert!(install_error(&manager, &source).contains("icon.png"));
    assert_eq!(installed(&manager).revision, first.revision);
    assert!(installed(&manager).icon_png_revision.is_none());

    fs::rename(source.join("icon.png"), source.join("icon-2048.png")).unwrap();
    manager.reload("example.page").unwrap();
    assert_eq!(installed(&manager).revision, first.revision);
    fs::write(source.join("icon.png"), png(1024, 1024)).unwrap();
    manager.reload("example.page").unwrap();
    let migrated = installed(&manager);
    assert_ne!(migrated.revision, first.revision);
    assert!(migrated.icon_png_revision.is_some());
}
#[cfg(unix)]
#[test]
fn reload_rejects_replaced_source_folder_symlink() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    fs::remove_dir_all(&source).unwrap();
    let replacement = temp.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    fs::write(
        replacement.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        replacement.join("plugin.js"),
        "export const escaped = true;",
    )
    .unwrap();
    std::os::unix::fs::symlink(&replacement, &source).unwrap();
    assert!(manager.reload("example.page").is_err());
    assert_eq!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        first
    );
}
#[test]
fn rollback_restores_reload_source_and_same_byte_reload_refreshes_source() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    let second_source = temp.path().join("second-build");
    fs::create_dir(&second_source).unwrap();
    fs::write(
        second_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        second_source.join("plugin.js"),
        "export const second = true;",
    )
    .unwrap();
    let second = manager
        .install(&second_source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert_ne!(second, first);
    manager.change("rollback", "example.page").unwrap();
    // Rollback consumes its target rather than turning the rejected update into a forward toggle.
    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let catalog = reopened.catalog().unwrap();
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_eq!(plugin.revision, first);
    assert!(plugin.previous.is_none());
    assert!(reopened
        .change("rollback", "example.page")
        .err()
        .unwrap()
        .contains("No previous revision"));
    fs::write(source.join("plugin.js"), "export const firstReload = true;").unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(plugin.revision, first);
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    let third_source = temp.path().join("third-build");
    fs::create_dir(&third_source).unwrap();
    fs::write(
        third_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        third_source.join("plugin.js"),
        "export const firstReload = true;",
    )
    .unwrap();
    let same = manager.install(&third_source).unwrap();
    let plugin = same
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    assert!(plugin.reloadable);
    let changed = "export const thirdReload = true;";
    fs::write(third_source.join("plugin.js"), changed).unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let reloaded = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(reloaded.revision, plugin.revision);
    assert_eq!(reloaded.previous.as_deref(), Some(plugin.revision.as_str()));
    manager.change("enable", "example.page").unwrap();
    assert_eq!(
        manager.module("example.page", &reloaded.revision).unwrap(),
        changed
    );
}
fn reload_from_exact_folder(name: &str, with_trimmed_sibling: bool) {
    let temp = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(temp.path().join("home")), "test", false).unwrap();
    let root = temp.path().join("plugins");
    let mut folders = vec![(name, "export const exact = 1;")];
    if with_trimmed_sibling {
        folders.push((name.trim(), "export const sibling = true;"));
    }
    for (folder, code) in folders {
        let folder = root.join(folder);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(folder.join("plugin.js"), code).unwrap();
    }
    let prepared = buzzodz_plugins::imports::prepare_folder(&root).unwrap();
    let first = prepared
        .install(&manager, &prepared.preview.token, name)
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert!(!first.enabled);
    assert!(first.reloadable);
    fs::write(root.join(name).join("plugin.js"), "export const exact = 2;").unwrap();
    let reloaded = manager
        .reload("example.page")
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(reloaded.revision, first.revision);
    manager.change("enable", "example.page").unwrap();
    assert_eq!(
        manager.module("example.page", &reloaded.revision).unwrap(),
        "export const exact = 2;"
    );
}
#[test]
fn reload_reads_the_exact_recorded_folder_name() {
    for name in [" plugin", "plugin ", " plugin "] {
        reload_from_exact_folder(name, true);
        reload_from_exact_folder(name, false);
    }
}
#[test]
fn invalid_install_preserves_working_revision() {
    let (_temp, manager, source) = fixture();
    let before = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    for metadata in [
        r#"{"id":"../escape","name":"Invalid","apiVersion":1}"#,
        r#"{"id":"example.page","name":"Invalid","apiVersion":2}"#,
        "{broken}",
    ] {
        fs::write(source.join("manifest.json"), metadata).unwrap();
        assert!(manager.install(&source).is_err());
        assert_eq!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.page")
                .unwrap()
                .revision,
            before
        );
    }
}
#[test]
fn corrupt_artifact_does_not_block_disable_or_remove() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    fs::write(
        temp.path().join(format!(
            "profiles/test/artifacts/example.page/{revision}.json"
        )),
        "broken",
    )
    .unwrap();
    assert!(manager.module("example.page", &revision).is_err());
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
}
#[test]
fn corrupt_settings_require_recovery_and_are_backed_up() {
    let (temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    let root = temp.path().join("profiles/test");
    fs::write(root.join("registry.json"), "{broken}").unwrap();
    assert!(manager.catalog().is_err());
    assert!(manager.change("disable", "buzz.channels").is_err());
    manager.recover().unwrap();
    assert!(manager.catalog().is_ok());
    let backup = fs::read_dir(root)
        .unwrap()
        .filter_map(|p| p.ok())
        .find(|p| {
            p.file_name()
                .to_string_lossy()
                .starts_with("registry-backup-")
        })
        .unwrap();
    assert_eq!(fs::read_to_string(backup.path()).unwrap(), "{broken}");
}
#[test]
fn safe_mode_and_profiles_are_independent() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    let safe = Manager::open(Some(temp.path().into()), "test", true).unwrap();
    assert!(safe.module("example.page", &revision).is_err());
    assert!(safe.external_plugins_paused());
    assert!(!manager.external_plugins_paused());
    assert!(
        safe.catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert!(manager.module("example.page", &revision).is_ok());
    safe.change("disable", "example.page").unwrap();
    assert_eq!(
        Manager::open(Some(temp.path().into()), "other", false)
            .unwrap()
            .catalog()
            .unwrap()
            .plugins
            .len(),
        bundled_manifests().len()
    );
}
#[test]
fn concurrent_changes_do_not_lose_installs() {
    let (_temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                for _ in 0..5 {
                    manager.change("disable", "buzz.github").unwrap();
                    manager.change("enable", "example.page").unwrap();
                }
            });
        }
    });
    let catalog = manager.catalog().unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.github")
            .unwrap()
            .enabled
    );
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
}
#[test]
fn management_never_executes_code_and_protects_bundled_identity() {
    let (_temp, manager, source) = fixture();
    fs::write(
        source.join("plugin.js"),
        "throw new Error('broken'); while(true) {}",
    )
    .unwrap();
    manager.install(&source).unwrap();
    manager.change("enable", "example.page").unwrap();
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
    fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&bundled_manifests()[0]).unwrap(),
    )
    .unwrap();
    assert!(manager.install(&source).is_err());
    assert!(manager
        .change("remove", &bundled_manifests()[0].id)
        .is_err());
}

#[test]
fn bundled_plugins_have_independent_flags_and_all_ids_are_reserved() {
    let (root, manager, source) = fixture();
    manager.change("disable", "buzz.github").unwrap();
    let catalog = manager.catalog().unwrap();
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.github")
            .unwrap()
            .enabled
    );
    for id in [
        "buzz.identity-naming",
        "buzz.terminal",
        "buzz.inbox",
        "buzz.repos",
        "buzz.voice-notes",
        "buzz.links",
    ] {
        assert!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        manager.change("disable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.channels")
                .unwrap()
                .enabled
        );
        manager.change("enable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.github")
                .unwrap()
                .enabled
        );
        assert!(manager.change("remove", id).is_err());
    }
    assert!(manager.change("remove", "buzz.channels").is_err());
    for manifest in buzzodz_plugins::bundled_manifests() {
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(manager.install(&source).is_err());
    }
    for id in ["buzz.emoji", "buzz.mentions"] {
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": id, "name": "Reserved feature", "apiVersion": 1
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            install_error(&manager, &source),
            "Cannot replace a bundled plugin"
        );
    }
    drop(root);
}

#[test]
fn feedback_is_in_native_catalog() {
    let (root, manager, _source) = fixture();
    assert!(bundled_manifests().iter().any(|m| m.id == "buzz.feedback"));
    assert!(manager
        .catalog()
        .unwrap()
        .plugins
        .iter()
        .any(|p| p.manifest.id == "buzz.feedback" && p.enabled));
    drop(root);
}

#[test]
fn channels_is_required_even_with_saved_disabled_settings() {
    let (root, manager, _source) = fixture();
    manager.change("disable", "buzz.github").unwrap();
    let path = root.path().join("profiles/test/registry.json");
    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["bundledOverrides"]["buzz.channels"] = serde_json::json!(false);
    let bytes = serde_json::to_vec(&saved).unwrap();
    fs::write(&path, &bytes).unwrap();
    for _ in 0..2 {
        let reopened = Manager::open(Some(root.path().into()), "test", false).unwrap();
        let catalog = reopened.catalog().unwrap();
        assert!(
            catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.channels")
                .unwrap()
                .enabled
        );
        assert!(
            !catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.github")
                .unwrap()
                .enabled
        );
        assert!(reopened
            .change("disable", "buzz.channels")
            .err()
            .unwrap()
            .contains("Channels is required"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    manager.change("enable", "buzz.github").unwrap();
    assert!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
}

#[test]
fn bundled_defaults_preserve_saved_choices_and_only_channels_is_required() {
    let (_root, manager, _source) = fixture();
    let catalog = manager.catalog().unwrap();
    assert!(catalog
        .plugins
        .iter()
        .any(|plugin| plugin.manifest.id == "buzz.inbox"));
    for plugin in &catalog.plugins {
        let id = plugin.manifest.id.as_str();
        let default = !matches!(
            id,
            "buzz.bestie"
                | "buzz.pi"
                | "buzz.opencode"
                | "buzz.todos"
                | "buzz.usage"
                | "buzz.relay-notes"
                | "buzz.reminders"
                | "buzz.workflows"
                | "buzz.focus"
        );
        assert_eq!(plugin.enabled, default, "{id}");
        if id == "buzz.channels" {
            assert!(manager.change("disable", id).is_err());
        } else {
            for enabled in [true, false] {
                manager
                    .change(if enabled { "enable" } else { "disable" }, id)
                    .unwrap();
                assert_eq!(
                    manager
                        .catalog()
                        .unwrap()
                        .plugins
                        .iter()
                        .find(|p| p.manifest.id == id)
                        .unwrap()
                        .enabled,
                    enabled,
                    "{id}"
                );
            }
        }
    }
    // Saved choices override default-off even across process restarts.
    for id in ["buzz.bestie", "buzz.reminders", "buzz.workflows"] {
        for enabled in [true, false] {
            manager
                .change(if enabled { "enable" } else { "disable" }, id)
                .unwrap();
            let reopened = Manager::open(Some(_root.path().to_path_buf()), "test", false).unwrap();
            assert_eq!(
                reopened
                    .catalog()
                    .unwrap()
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == id)
                    .unwrap()
                    .enabled,
                enabled,
                "{id}"
            );
        }
    }
}

#[test]
fn bundled_defaults_are_pinned_for_fresh_and_untouched_existing_profiles() {
    for existing in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("profiles/test");
        if existing {
            // Older catalog reads made a lock file even without saved settings.
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("registry.lock"), "").unwrap();
        }
        for _launch in 0..2 {
            let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
            let catalog = manager.catalog().unwrap();
            for id in ["buzz.reminders", "buzz.workflows"] {
                assert_eq!(
                    catalog
                        .plugins
                        .iter()
                        .find(|p| p.manifest.id == id)
                        .unwrap()
                        .enabled,
                    existing,
                    "{id}, existing={existing}"
                );
            }
            let saved: serde_json::Value =
                serde_json::from_slice(&fs::read(root.join("registry.json")).unwrap()).unwrap();
            for plugin in &catalog.plugins {
                assert_eq!(
                    saved["bundledOverrides"][&plugin.manifest.id],
                    plugin.enabled
                );
            }
        }
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        manager.change("disable", "buzz.workflows").unwrap();
        assert!(
            !manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.workflows")
                .unwrap()
                .enabled
        );
        manager.recover().unwrap();
        let reopened = Manager::open(Some(home.path().into()), "test", false).unwrap();
        for id in ["buzz.reminders", "buzz.workflows"] {
            assert!(
                !reopened
                    .catalog()
                    .unwrap()
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == id)
                    .unwrap()
                    .enabled,
                "reset {id}"
            );
        }
    }
}

#[test]
#[cfg(unix)]
fn failed_default_snapshot_does_not_block_untouched_upgrades() {
    use std::os::unix::fs::PermissionsExt;

    for saved_workflows in [None, Some(false)] {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("profiles/test");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("registry.lock"), "").unwrap();
        let settings = root.join("registry.json");
        let original = saved_workflows.map(|enabled| {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "version": 2, "bundledEnabled": true,
                "bundledOverrides": { "buzz.workflows": enabled }, "installed": {}
            }))
            .unwrap();
            fs::write(&settings, &bytes).unwrap();
            bytes
        });
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let permissions = fs::metadata(&root).unwrap().permissions();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let first = manager.catalog();
        let second = manager.catalog();
        let edit = manager.change("disable", "buzz.reminders");
        // Restore before asserting, so a failing test can clean up its profile.
        fs::set_permissions(&root, permissions).unwrap();
        assert!(edit.is_err(), "explicit edits must report the failed write");
        assert_eq!(fs::read(&settings).ok(), original);
        for result in [first, second] {
            let catalog = result.expect("a failed snapshot must not block launch");
            for (id, enabled) in [
                ("buzz.reminders", true),
                ("buzz.workflows", saved_workflows.unwrap_or(true)),
            ] {
                assert_eq!(
                    catalog
                        .plugins
                        .iter()
                        .find(|p| p.manifest.id == id)
                        .unwrap()
                        .enabled,
                    enabled,
                    "{id}"
                );
            }
        }
        // Once storage is writable, a later read must save the same decisions.
        manager.catalog().unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
        assert_eq!(saved["bundledOverrides"]["buzz.reminders"], true);
        assert_eq!(
            saved["bundledOverrides"]["buzz.workflows"],
            saved_workflows.unwrap_or(true)
        );
    }
}

#[test]
fn legacy_plugin_settings_preserve_choices_while_missing_flags_keep_old_defaults() {
    for saved in [None, Some(true), Some(false)] {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("profiles/test");
        fs::create_dir_all(&root).unwrap();
        let mut flags = serde_json::json!({ "buzz.github": false });
        if let Some(enabled) = saved {
            for id in ["buzz.reminders", "buzz.workflows"] {
                flags[id] = enabled.into();
            }
        }
        fs::write(
            root.join("registry.json"),
            serde_json::json!({
                "version": 2, "bundledEnabled": true,
                "bundledOverrides": flags, "installed": {}
            })
            .to_string(),
        )
        .unwrap();
        for _launch in 0..2 {
            let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
            let catalog = manager.catalog().unwrap();
            for id in ["buzz.reminders", "buzz.workflows"] {
                assert_eq!(
                    catalog
                        .plugins
                        .iter()
                        .find(|p| p.manifest.id == id)
                        .unwrap()
                        .enabled,
                    saved.unwrap_or(true),
                    "{id}, saved={saved:?}"
                );
            }
            assert!(
                !catalog
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == "buzz.github")
                    .unwrap()
                    .enabled
            );
            assert!(
                !catalog
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == "buzz.bestie")
                    .unwrap()
                    .enabled
            );
        }
    }
}

#[test]
fn built_in_conversation_features_are_absent_even_with_old_disabled_flags() {
    let (root, manager, _source) = fixture();
    fs::create_dir_all(manager.storage_root()).unwrap();
    fs::write(
        manager.storage_root().join("registry.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": 2,
            "bundledEnabled": true,
            "bundledOverrides": { "buzz.emoji": false, "buzz.mentions": false },
            "installed": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let reopened = Manager::open(Some(root.path().to_path_buf()), "test", false).unwrap();
    let catalog = reopened.catalog().unwrap();
    for id in ["buzz.emoji", "buzz.mentions"] {
        assert!(!catalog
            .plugins
            .iter()
            .any(|plugin| plugin.manifest.id == id));
        for action in ["enable", "disable", "remove", "rollback"] {
            assert_eq!(
                reopened.change(action, id).err().as_deref(),
                Some("Built-in conversation features cannot be managed as plugins"),
            );
        }
        assert_eq!(
            reopened.reload(id).err().as_deref(),
            Some("Bundled plugins cannot be reloaded from disk"),
        );
        assert_eq!(
            reopened.reload_live(id).err().as_deref(),
            Some("Bundled plugins cannot be reloaded from disk"),
        );
    }
}

#[test]
fn registry_cannot_restore_plugins_with_built_in_conversation_ids() {
    for id in ["buzz.emoji", "buzz.mentions"] {
        let (_root, manager, source) = fixture();
        manager.install(&source).unwrap();
        let path = manager.storage_root().join("registry.json");
        let mut registry: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let installed = registry["installed"].as_object_mut().unwrap();
        let mut plugin = installed.remove("example.page").unwrap();
        plugin["manifest"]["id"] = serde_json::json!(id);
        installed.insert(id.into(), plugin);
        fs::write(&path, serde_json::to_vec(&registry).unwrap()).unwrap();
        assert_eq!(
            manager.catalog().err().as_deref(),
            Some("Invalid installed plugin identity"),
        );
    }
}

#[test]
fn managed_policy_lives_beside_profiles_and_never_installs() {
    use buzzodz_plugins::managed::{Managed, ManagedState};
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    let catalog = manager.catalog().unwrap();
    assert!(manager.managed(&catalog).is_absent());
    fs::write(
        home.path().join("managed-plugins.json"),
        r#"{"version":1,"source":"Example Org","plugins":[
            {"id":"example.managed","repository":"https://example.com/plugins","reference":"v1","commit":"0123456789abcdef0123456789abcdef01234567"},
            {"id":"broken"}
        ]}"#,
    )
    .unwrap();
    let Managed::Ready {
        source,
        plugins,
        problems,
        ..
    } = manager.managed(&catalog)
    else {
        panic!("expected a usable policy");
    };
    assert_eq!(source, "Example Org");
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].state, ManagedState::Missing);
    assert_eq!(problems.len(), 1);
    let after = manager.catalog().unwrap();
    assert!(!after
        .plugins
        .iter()
        .any(|plugin| plugin.manifest.id == "example.managed"));
}
