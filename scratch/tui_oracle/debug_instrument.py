# Temporary debug instrumentation (revert after use).
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui.rs"
src = io.open(p, encoding="utf-8", newline="").read()

old = """        let restore_state = self.get_visible_overlay_focus_restore();
        if next_focus.is_some() && !next_focus_is_overlay {"""
new = """        let restore_state = self.get_visible_overlay_focus_restore();
        eprintln!(
            "[set_focus] prev={:?} next_is_overlay={} state={:?}",
            previous_focus.as_ref().map(|h| h.id()),
            next_focus_is_overlay,
            match &restore_state {
                OverlayFocusRestore::Inactive => "inactive".to_string(),
                OverlayFocusRestore::Eligible { overlay_id } => format!("eligible({overlay_id})"),
                OverlayFocusRestore::Blocked { overlay_id, .. } => format!("blocked({overlay_id})"),
            },
        );
        if next_focus.is_some() && !next_focus_is_overlay {"""
assert src.count(old) == 1
src = src.replace(old, new)

old2 = """                if matches!(resume, OverlayFocusResume::FocusTarget { .. })
                    || !self.is_component_mounted(&blocked_by)
                {
                    next_focus =
                        self.resolve_blocked_overlay_focus_restore(overlay_id, &blocked_by, resume);"""
new2 = """                eprintln!(
                    "[blocked] resume_focus_target={} mounted={}",
                    matches!(resume, OverlayFocusResume::FocusTarget { .. }),
                    self.is_component_mounted(&blocked_by)
                );
                if matches!(resume, OverlayFocusResume::FocusTarget { .. })
                    || !self.is_component_mounted(&blocked_by)
                {
                    next_focus =
                        self.resolve_blocked_overlay_focus_restore(overlay_id, &blocked_by, resume);"""
assert src.count(old2) == 1
src = src.replace(old2, new2)

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("instrumented")
