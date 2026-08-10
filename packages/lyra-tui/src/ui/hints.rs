//! The contextual hint line and the `?` cheatsheet.
//!
//! Both are **generated from [`crate::keybind::BINDINGS`]**, which is the point
//! of DESIGN.md §4's registry: "the cheatsheet, `?` help, and contextual hint bar
//! are generated from it. No scattered handlers." Nothing in this module knows a
//! key name; it asks the keymap what is reachable from the current context stack
//! and prints the answer.
//!
//! # Relabelling
//!
//! One binding legitimately means different things at different moments: `Esc`
//! is a ladder ([`crate::input::esc`]), so the hint has to say `cancel` while a
//! turn runs and `unqueue` when the queue is what would change. [`render`] takes
//! a relabelling closure for exactly that case, and the *binding* is still the
//! single source of the key name — only the verb is contextual.
//!
//! # Degradation
//!
//! The hint line is one row, always (DESIGN.md §3: fixed-height chrome). Hints
//! are dropped lowest-priority-first when the width runs out, and a visible `…`
//! marks that something was dropped.

use unicode_width::UnicodeWidthStr;

use crate::keybind::{Action, CheatEntry, ContextStack, Hint, Keymap};
use crate::theme::Theme;
use crate::ui::{Row, Span};

/// Render the hint line for a context stack.
///
/// `relabel` may replace a hint's verb; returning `None` keeps the declared one.
#[must_use]
pub fn render(
    theme: &Theme,
    keymap: &Keymap,
    stack: &ContextStack,
    width: u16,
    relabel: impl Fn(Action) -> Option<String>,
) -> Row {
    let hints = keymap.hints(stack);
    render_hints(theme, &hints, width, relabel)
}

/// As [`render`], from a pre-computed hint list.
#[must_use]
pub fn render_hints(
    theme: &Theme,
    hints: &[Hint],
    width: u16,
    relabel: impl Fn(Action) -> Option<String>,
) -> Row {
    let width = width as usize;
    let mut items: Vec<(u8, String, String)> = hints
        .iter()
        .map(|hint| {
            let verb = relabel(hint.action).unwrap_or_else(|| hint.short.to_owned());
            (hint.priority, hint.key.clone(), verb)
        })
        .filter(|(_, _, verb)| !verb.is_empty())
        .collect();

    if items.is_empty() {
        return Row::blank();
    }

    let mut dropped = false;
    loop {
        let row = lay_out(theme, &items, dropped);
        if row.width() <= width {
            return row;
        }
        if items.len() == 1 {
            // One hint that still does not fit: clip it rather than emit a row
            // wider than the terminal, which would wrap and cost a second line.
            return clip_row(row, width);
        }
        let lowest = items
            .iter()
            .enumerate()
            .min_by_key(|(_, (priority, _, _))| *priority)
            .map(|(index, _)| index);
        match lowest {
            Some(index) => {
                items.remove(index);
                dropped = true;
            }
            None => return Row::blank(),
        }
    }
}

/// Clip a row to `width` columns, leaving a visible ellipsis.
fn clip_row(row: Row, width: usize) -> Row {
    let budget = width.saturating_sub(1);
    let mut spans: Vec<Span> = Vec::new();
    let mut used = 0usize;
    for span in row.spans {
        if used >= budget {
            break;
        }
        let text = clip_exact(&span.text, budget - used);
        used += UnicodeWidthStr::width(text.as_str());
        spans.push(Span::new(text, span.style));
    }
    if width > 0 {
        spans.push(Span::new("…", crate::ui::Style::dim()));
    }
    Row { spans }
}

/// Truncate to `limit` columns with no ellipsis of its own.
fn clip_exact(text: &str, limit: usize) -> String {
    if UnicodeWidthStr::width(text) <= limit {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > limit {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out
}

fn lay_out(theme: &Theme, items: &[(u8, String, String)], dropped: bool) -> Row {
    let mut spans = Vec::with_capacity(items.len() * 3 + 1);
    for (index, (_, key, verb)) in items.iter().enumerate() {
        if index > 0 {
            spans.push(Span::new(" · ", theme.faint()));
        }
        spans.push(Span::new(key.clone(), theme.accent()));
        spans.push(Span::new(format!(" {verb}"), theme.muted()));
    }
    if dropped {
        spans.push(Span::new(" …", theme.faint()));
    }
    Row { spans }
}

/// The `?` cheatsheet overlay: every bound action, grouped by context.
///
/// Returned as rows so the caller can put it wherever an overlay goes; this
/// module has no opinion about where overlays live.
#[must_use]
pub fn cheatsheet(theme: &Theme, keymap: &Keymap, width: u16) -> Vec<Row> {
    let width = width.max(20) as usize;
    let groups = keymap.cheatsheet();
    let key_column = groups
        .iter()
        .flat_map(|(_, entries)| entries.iter())
        .map(|entry| UnicodeWidthStr::width(entry.keys.as_str()))
        .max()
        .unwrap_or(0)
        .min(width / 3);

    let mut rows = vec![
        Row {
            spans: vec![
                Span::new("keys", theme.accent()),
                Span::new("  ·  esc or q to close", theme.faint()),
            ],
        },
        Row::blank(),
    ];
    for (context, entries) in groups {
        rows.push(Row {
            spans: vec![Span::new(context.title(), theme.agent())],
        });
        for entry in entries {
            rows.push(cheat_row(theme, &entry, key_column, width));
        }
        rows.push(Row::blank());
    }
    // A trailing blank adds nothing but height.
    if rows.last() == Some(&Row::blank()) {
        rows.pop();
    }
    rows
}

fn cheat_row(theme: &Theme, entry: &CheatEntry, key_column: usize, width: usize) -> Row {
    let keys = clip(&entry.keys, key_column);
    let pad = key_column.saturating_sub(UnicodeWidthStr::width(keys.as_str()));
    let used = 2 + key_column + 2;
    let description = clip(entry.description, width.saturating_sub(used));
    Row {
        spans: vec![
            Span::new("  ", theme.faint()),
            Span::new(keys, theme.accent()),
            Span::new(" ".repeat(pad + 2), theme.faint()),
            Span::new(description, theme.muted()),
        ],
    }
}

fn clip(text: &str, limit: usize) -> String {
    if UnicodeWidthStr::width(text) <= limit {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > limit.saturating_sub(1) {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keymap() -> Keymap {
        Keymap::default()
    }

    fn line(stack: &ContextStack, width: u16) -> String {
        render(&Theme::lyra(), &keymap(), stack, width, |_| None).plain_text()
    }

    #[test]
    fn the_hint_line_names_the_keys_the_registry_declares() {
        let stack = ContextStack::build(false, false, true, false);
        let rendered = line(&stack, 120);
        assert!(rendered.contains("enter send"), "{rendered}");
        assert!(rendered.contains("esc back"), "{rendered}");
        assert!(rendered.contains("tab expand"), "{rendered}");
        assert!(rendered.contains("? help"), "{rendered}");
    }

    #[test]
    fn streaming_surfaces_the_steer_hint() {
        let idle = line(&ContextStack::build(false, false, false, false), 120);
        let streaming = line(&ContextStack::build(false, false, false, true), 120);
        assert!(!idle.contains("ctrl+s"), "{idle}");
        assert!(streaming.contains("ctrl+s steer now"), "{streaming}");
    }

    #[test]
    fn a_relabelled_action_keeps_its_declared_key() {
        let stack = ContextStack::build(false, false, false, true);
        let rendered = render(&Theme::lyra(), &keymap(), &stack, 120, |action| {
            (action == Action::Escape).then(|| "cancel".to_owned())
        })
        .plain_text();
        assert!(rendered.contains("esc cancel"), "{rendered}");
        assert!(!rendered.contains("esc back"), "{rendered}");
    }

    #[test]
    fn a_relabel_to_nothing_removes_the_hint_entirely() {
        let stack = ContextStack::build(false, false, false, false);
        let rendered = render(&Theme::lyra(), &keymap(), &stack, 120, |action| {
            (action == Action::Escape).then(String::new)
        })
        .plain_text();
        assert!(!rendered.contains("esc"), "{rendered}");
    }

    #[test]
    fn the_hint_line_degrades_by_priority_with_a_visible_marker() {
        let stack = ContextStack::build(false, false, true, true);
        let wide = line(&stack, 200);
        assert!(!wide.contains('…'));
        let narrow = line(&stack, 30);
        assert!(narrow.contains('…'), "{narrow}");
        assert!(
            narrow.contains("enter send"),
            "the highest-priority hint survives: {narrow}"
        );
    }

    #[test]
    fn the_hint_line_never_overflows_at_any_width() {
        let stack = ContextStack::build(false, false, true, true);
        for width in 4u16..=120 {
            let row = render(&Theme::lyra(), &keymap(), &stack, width, |_| None);
            assert!(
                row.width() <= width as usize,
                "width {width}: {:?}",
                row.plain_text()
            );
        }
    }

    #[test]
    fn an_overlay_context_hints_how_to_leave_it() {
        let rendered = line(&ContextStack::build(true, false, true, false), 120);
        assert!(rendered.contains("q close"), "{rendered}");
        assert!(!rendered.contains("enter send"), "{rendered}");
    }

    #[test]
    fn the_cheatsheet_lists_every_bound_action_exactly_once() {
        let keymap = keymap();
        let entries: usize = keymap
            .cheatsheet()
            .iter()
            .map(|(_, entries)| entries.len())
            .sum();
        assert_eq!(
            entries,
            crate::keybind::BINDINGS.len(),
            "every declaration reaches help, and none reaches it twice"
        );

        // …and every one of them actually gets a row.
        let rows = cheatsheet(&Theme::lyra(), &keymap, 200);
        let text: Vec<String> = rows.iter().map(Row::plain_text).collect();
        for (_, group) in keymap.cheatsheet() {
            for entry in group {
                let first = entry.keys.split(" / ").next().unwrap().to_owned();
                assert!(
                    text.iter().any(|row| row.contains(&first)),
                    "{} is missing from the cheatsheet",
                    entry.action.id()
                );
            }
        }
    }

    #[test]
    fn the_cheatsheet_is_grouped_and_headed() {
        let rows = cheatsheet(&Theme::lyra(), &keymap(), 100);
        let text: Vec<String> = rows.iter().map(Row::plain_text).collect();
        assert!(text[0].starts_with("keys"));
        assert!(text.iter().any(|row| row == "composer"));
        assert!(text.iter().any(|row| row == "while streaming"));
    }

    #[test]
    fn the_cheatsheet_fits_its_width() {
        for width in [40u16, 60, 100] {
            for row in cheatsheet(&Theme::lyra(), &keymap(), width) {
                assert!(
                    row.width() <= width as usize,
                    "width {width}: {:?}",
                    row.plain_text()
                );
            }
        }
    }

    #[test]
    fn an_unbound_action_never_reaches_a_help_surface() {
        let overrides =
            crate::keybind::config::KeyOverrides::from_document("[tui.keys]\npalette = false\n");
        let keymap = Keymap::new(&overrides);
        let text: String = cheatsheet(&Theme::lyra(), &keymap, 100)
            .iter()
            .map(Row::plain_text)
            .collect();
        assert!(!text.contains("command palette"), "{text}");
    }
}
