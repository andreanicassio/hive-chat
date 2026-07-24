// Evita una seconda finestra di console su Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hive_desktop_lib::run()
}
