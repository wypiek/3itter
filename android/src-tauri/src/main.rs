// Desktop entry point (handy for testing the instance picker on a computer).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    itter_app_lib::run()
}
