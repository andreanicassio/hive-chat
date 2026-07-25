use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, State, Url, WindowEvent};

/// Il runner locale come processo figlio dell'app: uno alla volta.
struct RunnerState(Mutex<Option<Child>>);

/// URL della schermata iniziale (bundle), per il menu "Cambia server".
struct StartUrl(Mutex<Option<Url>>);

/// Avvia il runner locale (`deploy/hive-runner.sh`) come figlio dell'app.
#[tauri::command]
fn start_runner(
    repo_path: String,
    env_file: Option<String>,
    state: State<RunnerState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok("Il runner è già in esecuzione.".into());
        }
    }
    let repo = repo_path.trim_end_matches('/');
    let script = format!("{repo}/deploy/hive-runner.sh");
    let mut cmd = Command::new("bash");
    cmd.arg(&script).current_dir(repo);
    if let Some(ef) = env_file {
        if !ef.trim().is_empty() {
            cmd.arg(ef);
        }
    }
    let child = cmd.spawn().map_err(|e| format!("Avvio del runner fallito: {e}"))?;
    *guard = Some(child);
    Ok("Runner avviato.".into())
}

/// Ferma il runner locale, se attivo.
#[tauri::command]
fn stop_runner(state: State<RunnerState>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        Ok("Runner fermato.".into())
    } else {
        Ok("Il runner non era in esecuzione.".into())
    }
}

/// Il runner è vivo in questo momento?
#[tauri::command]
fn runner_running(state: State<RunnerState>) -> bool {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(RunnerState(Mutex::new(None)))
        .manage(StartUrl(Mutex::new(None)))
        // Menu nativo: Modifica (copia/incolla nel webview), Vista (Ricarica,
        // Cambia server). Senza questo non funzionano né ⌘R né ⌘C nella chat.
        .menu(|app| {
            let reload = MenuItemBuilder::with_id("reload", "Ricarica")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let change = MenuItemBuilder::with_id("change_server", "Cambia server…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Hive")
                .about(None)
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Modifica")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "Vista")
                .item(&reload)
                .item(&change)
                .build()?;

            MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu])
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.location.reload()");
                }
            }
            "change_server" => {
                // Torna alla schermata iniziale del bundle (dove scegli il server).
                let start = app
                    .try_state::<StartUrl>()
                    .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
                if let (Some(w), Some(url)) = (app.get_webview_window("main"), start) {
                    let _ = w.navigate(url);
                }
            }
            _ => {}
        })
        .setup(|app| {
            // Ricordiamo l'URL della schermata iniziale, per "Cambia server".
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(u) = w.url() {
                    if let Some(state) = app.try_state::<StartUrl>() {
                        if let Ok(mut g) = state.0.lock() {
                            *g = Some(u);
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_runner,
            stop_runner,
            runner_running
        ])
        .on_window_event(|window, event| {
            // Chiudendo l'app fermiamo il runner locale che le fa da figlio.
            if let WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<RunnerState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("errore nell'avvio dell'app Hive");
}
