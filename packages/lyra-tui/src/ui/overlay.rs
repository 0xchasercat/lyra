//! Overlays — the one floated surface this TUI has.
//!
//! DESIGN.md §5 forbids a second rendering mode, an alt-screen and an internal
//! viewport, so an "overlay" here is not a window: it is a bordered panel drawn
//! into the **bottom live region**, above the composer, for as long as it is
//! open. Everything above the fold stays exactly where it was printed.
//!
//! # Three bodies, and no fourth
//!
//! A filterable list ([`Select`]), a scrollable block ([`Rows`]), and a column
//! of fields ([`Form`]). Every surface this client has is one of them:
//!
//! | surface | body | items from |
//! |---|---|---|
//! | `Ctrl+P` palette | [`Select`] | the keybinding registry + `session/commands` |
//! | `/model`, `/provider`, `/sessions`, `/theme` | [`Select`] | ACP, or the theme registry |
//! | `?` cheatsheet | [`Rows`] | [`crate::ui::hints::cheatsheet`] |
//! | provider setup | [`Form`] | `provider/setup_options` |
//!
//! The form is the one body that takes an answer rather than a choice, which is
//! why it — and only it — owns the keyboard caret and a keymap context of its
//! own. It lives in [`crate::ui::form`]; this module only frames it.
//!
//! # Ranking is a property of the source, not of the widget
//!
//! [`Ranking::Local`] filters and re-orders with the fuzzy matcher below.
//! [`Ranking::Server`] does neither: the daemon has already ranked those items
//! with context this process does not have, so typing re-queries rather than
//! re-sorting (DESIGN.md §4, "server-ranked, **not re-sorted**"). The widget
//! cannot re-sort a server list even by accident — [`Select::set_items`] only
//! consults the matcher when the ranking is local.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::input::completion::CompletionItem;
use crate::theme::Theme;
use crate::ui::form::Form;
use crate::ui::{Row, Span, Style};

/// Columns the panel frame costs: two borders and two pads.
const FRAME_COLUMNS: usize = 4;

/// Columns the selection marker occupies inside the frame.
const MARKER_COLUMNS: usize = 2;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/// One selectable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// What the caller gets back when this row is accepted. Never displayed.
    pub value: String,
    /// The text shown in the left column.
    pub label: String,
    /// Right-hand column: a description, a price, a path.
    pub detail: Option<String>,
    /// Whether this is the item already in force (the current model, the active
    /// session). Marked, and pre-selected when the list opens.
    pub current: bool,
}

impl Choice {
    /// A choice whose value is also its label.
    #[must_use]
    pub fn new(label: impl Into<String>) -> Self {
        let label = label.into();
        Self {
            value: label.clone(),
            label,
            detail: None,
            current: false,
        }
    }

    /// A choice with a value distinct from its label.
    #[must_use]
    pub fn valued(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            detail: None,
            current: false,
        }
    }

    /// Attach the right-hand column.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.is_empty()).then_some(detail);
        self
    }

    /// Mark this as the item already in force.
    #[must_use]
    pub const fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    /// The text the local matcher scores against.
    fn haystack(&self) -> String {
        match &self.detail {
            Some(detail) => format!("{} {detail}", self.label),
            None => self.label.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/// Score `text` against `query` as a subsequence match, or `None` if it is not
/// one.
///
/// Deliberately small: a prefix match beats a word-start match beats a scattered
/// one, and that is the whole model. An empty query matches everything with a
/// score of zero, which keeps the unfiltered list in source order.
#[must_use]
pub fn fuzzy_score(query: &str, text: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let needle: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    let hay: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut score = 0i64;
    let mut at = 0usize;
    let mut previous: Option<usize> = None;
    for wanted in needle {
        let found = hay[at..].iter().position(|c| *c == wanted)? + at;
        score += match previous {
            // Consecutive characters are what a user typing a prefix produces.
            Some(previous) if found == previous + 1 => 12,
            _ => 0,
        };
        // A match at a word boundary is nearly as good as a consecutive one.
        if found == 0 {
            score += 16;
        } else if matches!(hay[found - 1], ' ' | '-' | '_' | '/' | '.' | ':') {
            score += 8;
        }
        // Later matches are worth less: `model` should beat `remodelled`.
        score -= i64::try_from(found.min(64)).unwrap_or(64) / 4;
        previous = Some(found);
        at = found + 1;
    }
    Some(score)
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/// Who ranked the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ranking {
    /// This process did. Typing filters and re-orders locally.
    Local,
    /// The daemon did. Typing re-queries; the order it returned is final.
    Server,
}

/// A filterable single-selection list.
#[derive(Debug, Clone)]
pub struct Select {
    items: Vec<Choice>,
    /// Indices into `items`, in display order.
    visible: Vec<usize>,
    query: String,
    selected: usize,
    ranking: Ranking,
    loading: bool,
}

impl Select {
    /// An empty list, waiting for its items.
    #[must_use]
    pub const fn new(ranking: Ranking) -> Self {
        Self {
            items: Vec::new(),
            visible: Vec::new(),
            query: String::new(),
            selected: 0,
            ranking,
            loading: true,
        }
    }

    /// An already-populated local list.
    #[must_use]
    pub fn local(items: Vec<Choice>) -> Self {
        let mut select = Self::new(Ranking::Local);
        select.set_items(items);
        select
    }

    /// Install items.
    ///
    /// **In the order given** when the ranking is [`Ranking::Server`]. That is
    /// the rule, not an omission: see the module docs.
    pub fn set_items(&mut self, items: Vec<Choice>) {
        self.items = items;
        self.loading = false;
        self.refilter();
        // Open on whatever is already in force, so `enter` on an untouched
        // picker is a no-op rather than a silent switch to the first row.
        if self.query.is_empty()
            && let Some(at) = self
                .visible
                .iter()
                .position(|index| self.items[*index].current)
        {
            self.selected = at;
        }
    }

    /// Whether the list is still waiting for its first answer.
    #[must_use]
    pub const fn is_loading(&self) -> bool {
        self.loading
    }

    /// Say so when a request went out for a query that is already on screen.
    pub const fn set_loading(&mut self, loading: bool) {
        self.loading = loading;
    }

    /// Where filtering happens.
    #[must_use]
    pub const fn ranking(&self) -> Ranking {
        self.ranking
    }

    /// The filter text.
    #[must_use]
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Extend the filter. Returns whether a server re-query is owed.
    pub fn insert(&mut self, text: &str) -> bool {
        self.query.push_str(text);
        self.after_query_change()
    }

    /// Shorten the filter. Returns whether a server re-query is owed.
    pub fn backspace(&mut self) -> bool {
        if self.query.is_empty() {
            return false;
        }
        let mut graphemes: Vec<&str> = self.query.graphemes(true).collect();
        graphemes.pop();
        self.query = graphemes.concat();
        self.after_query_change()
    }

    fn after_query_change(&mut self) -> bool {
        match self.ranking {
            Ranking::Local => {
                self.refilter();
                false
            }
            Ranking::Server => {
                // Stale rows for the previous query must not be shown for this
                // one, exactly as `CompletionState::request_for` does it.
                self.items.clear();
                self.visible.clear();
                self.selected = 0;
                self.loading = true;
                true
            }
        }
    }

    fn refilter(&mut self) {
        if matches!(self.ranking, Ranking::Server) {
            self.visible = (0..self.items.len()).collect();
            self.selected = self.selected.min(self.visible.len().saturating_sub(1));
            return;
        }
        let mut scored: Vec<(i64, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                fuzzy_score(&self.query, &item.haystack()).map(|score| (score, index))
            })
            .collect();
        // Stable by construction: equal scores keep declaration order.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        self.visible = scored.into_iter().map(|(_, index)| index).collect();
        self.selected = 0;
    }

    /// Move the highlight down, wrapping.
    pub fn next(&mut self) {
        if !self.visible.is_empty() {
            self.selected = (self.selected + 1) % self.visible.len();
        }
    }

    /// Move the highlight up, wrapping.
    pub fn prev(&mut self) {
        if !self.visible.is_empty() {
            self.selected = (self.selected + self.visible.len() - 1) % self.visible.len();
        }
    }

    /// Index of the highlighted row among the visible ones.
    #[must_use]
    pub const fn selected(&self) -> usize {
        self.selected
    }

    /// The highlighted choice.
    #[must_use]
    pub fn selection(&self) -> Option<&Choice> {
        self.visible.get(self.selected).map(|index| &self.items[*index])
    }

    /// The rows that pass the filter, in display order.
    pub fn visible(&self) -> impl ExactSizeIterator<Item = &Choice> {
        self.visible.iter().map(|index| &self.items[*index])
    }

    /// How many rows pass the filter.
    #[must_use]
    pub fn len(&self) -> usize {
        self.visible.len()
    }

    /// Whether nothing passes the filter.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.visible.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// A scrollable block of pre-rendered rows. The `?` cheatsheet is one.
#[derive(Debug, Clone)]
pub struct Rows {
    rows: Vec<Row>,
    offset: usize,
}

impl Rows {
    /// Wrap pre-rendered rows.
    #[must_use]
    pub const fn new(rows: Vec<Row>) -> Self {
        Self { rows, offset: 0 }
    }

    /// Scroll up one row.
    pub const fn scroll_up(&mut self) {
        self.offset = self.offset.saturating_sub(1);
    }

    /// Scroll down one row, stopping when the last row is on screen.
    pub fn scroll_down(&mut self, viewport: usize) {
        let last = self.rows.len().saturating_sub(viewport.max(1));
        self.offset = (self.offset + 1).min(last);
    }

    /// The rows on screen for a viewport of `viewport` rows.
    #[must_use]
    pub fn window(&self, viewport: usize) -> &[Row] {
        let start = self.offset.min(self.rows.len());
        let end = (start + viewport).min(self.rows.len());
        &self.rows[start..end]
    }

    /// Total row count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether there is nothing to show.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Whether anything is scrolled out of view above or below.
    #[must_use]
    pub fn is_scrolled(&self, viewport: usize) -> bool {
        self.offset > 0 || self.rows.len() > viewport
    }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/// What an overlay is showing.
#[derive(Debug)]
pub enum Body {
    /// A filterable list.
    Select(Select),
    /// A scrollable block of rows.
    Rows(Rows),
    /// A column of labelled fields. See [`crate::ui::form`].
    Form(Form),
}

/// A bordered panel, floated over the live region.
#[derive(Debug)]
pub struct Panel {
    /// Shown in the top border.
    pub title: String,
    /// Shown in the bottom border.
    pub hint: String,
    /// The content.
    pub body: Body,
}

impl Panel {
    /// A select panel.
    #[must_use]
    pub fn select(title: impl Into<String>, select: Select) -> Self {
        Self {
            title: title.into(),
            hint: "↑↓ move · enter choose · esc close".to_owned(),
            body: Body::Select(select),
        }
    }

    /// A rows panel.
    #[must_use]
    pub fn rows(title: impl Into<String>, rows: Vec<Row>) -> Self {
        Self {
            title: title.into(),
            hint: "↑↓ scroll · esc close".to_owned(),
            body: Body::Rows(Rows::new(rows)),
        }
    }

    /// A form panel.
    #[must_use]
    pub fn form(title: impl Into<String>, form: Form) -> Self {
        Self {
            title: title.into(),
            hint: "tab next · ←→ choose · ctrl+t check · enter save · esc cancel".to_owned(),
            body: Body::Form(form),
        }
    }

    /// The list, when this is one.
    #[must_use]
    pub const fn as_select(&self) -> Option<&Select> {
        match &self.body {
            Body::Select(select) => Some(select),
            Body::Rows(_) | Body::Form(_) => None,
        }
    }

    /// The list, mutably.
    pub const fn as_select_mut(&mut self) -> Option<&mut Select> {
        match &mut self.body {
            Body::Select(select) => Some(select),
            Body::Rows(_) | Body::Form(_) => None,
        }
    }

    /// The scrollable block, mutably.
    pub const fn as_rows_mut(&mut self) -> Option<&mut Rows> {
        match &mut self.body {
            Body::Rows(rows) => Some(rows),
            Body::Select(_) | Body::Form(_) => None,
        }
    }

    /// The form, when this is one.
    #[must_use]
    pub const fn as_form(&self) -> Option<&Form> {
        match &self.body {
            Body::Form(form) => Some(form),
            Body::Select(_) | Body::Rows(_) => None,
        }
    }

    /// The form, mutably.
    pub const fn as_form_mut(&mut self) -> Option<&mut Form> {
        match &mut self.body {
            Body::Form(form) => Some(form),
            Body::Select(_) | Body::Rows(_) => None,
        }
    }

    /// Content rows this panel would like, capped at `max`.
    #[must_use]
    pub fn content_height(&self, max: usize) -> usize {
        let wanted = match &self.body {
            // Never zero: an empty list still says "nothing matches", and a
            // chrome row that collapses 0↔1 is exactly what DESIGN.md §3 bans.
            Body::Select(select) => select.len().max(1),
            Body::Rows(rows) => rows.len().max(1),
            Body::Form(form) => form.height(),
        };
        wanted.min(max.max(1))
    }

    /// Total rows this panel occupies, capped by `max_content` content rows.
    ///
    /// A select overlay pays one extra row for its filter; a form does not have
    /// one, because every keystroke in a form belongs to a field.
    #[must_use]
    pub fn height(&self, max_content: usize) -> u16 {
        let filter = usize::from(matches!(self.body, Body::Select(_)));
        let total = self.content_height(max_content) + filter + 2;
        u16::try_from(total).unwrap_or(u16::MAX)
    }
}

/// A drawn panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// Rows, top border first.
    pub rows: Vec<Row>,
    /// Caret `(column, row)` within [`Rendered::rows`], for a filter the user is
    /// typing into. `None` leaves the caret wherever the caller had it.
    pub caret: Option<(u16, u16)>,
}

/// Draw a panel at `width` columns with at most `max_content` content rows.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn render(theme: &Theme, panel: &Panel, width: u16, max_content: usize) -> Rendered {
    let width = width.max(12);
    let inner = inner_width(width);
    let border = theme.accent();
    let mut rows = vec![rule(width, border, '╭', '╮', Some((&panel.title, theme.agent())))];
    let mut caret = None;

    match &panel.body {
        Body::Select(select) => {
            let query = truncate(select.query(), inner.saturating_sub(MARKER_COLUMNS));
            let used = MARKER_COLUMNS + UnicodeWidthStr::width(query.as_str());
            rows.push(Row {
                spans: vec![
                    Span::new("│ ", border),
                    Span::new("› ", theme.faint()),
                    Span::new(query, theme.text()),
                    Span::new(" ".repeat(inner.saturating_sub(used)), Style::default()),
                    Span::new(" │", border),
                ],
            });
            caret = Some((
                u16::try_from(2 + used).unwrap_or(u16::MAX).min(width - 2),
                1,
            ));

            let viewport = panel.content_height(max_content);
            if select.is_empty() {
                let notice = if select.is_loading() {
                    "…"
                } else {
                    "nothing matches"
                };
                rows.push(content_row(
                    width,
                    border,
                    vec![Span::new(notice.to_owned(), theme.faint())],
                ));
            } else {
                // Scroll so the highlight stays inside the viewport, the same
                // rule the composer uses for its caret.
                let first = select
                    .selected()
                    .saturating_sub(viewport.saturating_sub(1))
                    .min(select.len().saturating_sub(viewport));
                for (offset, choice) in select
                    .visible()
                    .skip(first)
                    .take(viewport)
                    .enumerate()
                {
                    let index = first + offset;
                    rows.push(choice_row(
                        theme,
                        width,
                        border,
                        choice,
                        index == select.selected(),
                    ));
                }
            }
        }
        Body::Rows(block) => {
            let viewport = panel.content_height(max_content);
            let window = block.window(viewport);
            for row in window {
                rows.push(content_row(width, border, row.spans.clone()));
            }
            for _ in window.len()..viewport {
                rows.push(content_row(width, border, Vec::new()));
            }
        }
        Body::Form(form) => {
            let viewport = panel.content_height(max_content);
            // The form owns the caret, so the panel takes the column it reports
            // and offsets it past the frame. Nothing else in the panel knows
            // which field is focused, and nothing else needs to.
            for line in crate::ui::form::render(theme, form, inner, viewport) {
                if let Some(column) = line.caret {
                    caret = Some((
                        u16::try_from(2 + column).unwrap_or(u16::MAX).min(width - 2),
                        u16::try_from(rows.len()).unwrap_or(u16::MAX),
                    ));
                }
                rows.push(content_row(width, border, line.spans));
            }
        }
    }

    rows.push(rule(width, border, '╰', '╯', Some((&panel.hint, theme.faint()))));
    Rendered { rows, caret }
}

/// The completion popup: the same frame, no filter row, and the list is the
/// composer's own [`crate::input::completion::CompletionState`].
///
/// Items are drawn **in the order given**. The popup has no opinion about
/// ranking and no way to express one.
#[must_use]
pub fn popup(
    theme: &Theme,
    items: &[CompletionItem],
    selected: usize,
    width: u16,
    max_rows: usize,
) -> Vec<Row> {
    if items.is_empty() {
        return Vec::new();
    }
    let width = width.max(12);
    let border = theme.faint();
    let viewport = max_rows.max(1).min(items.len());
    let first = selected
        .saturating_sub(viewport.saturating_sub(1))
        .min(items.len().saturating_sub(viewport));

    let mut rows = vec![rule(width, border, '╭', '╮', None)];
    for (offset, item) in items.iter().skip(first).take(viewport).enumerate() {
        let choice = Choice {
            value: item.insert.clone(),
            label: item.label.clone(),
            detail: item.detail.clone(),
            current: false,
        };
        rows.push(choice_row(
            theme,
            width,
            border,
            &choice,
            first + offset == selected,
        ));
    }
    rows.push(rule(
        width,
        border,
        '╰',
        '╯',
        Some(("tab accept · esc dismiss", theme.faint())),
    ));
    rows
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/// Columns available to content inside the frame.
#[must_use]
pub fn inner_width(width: u16) -> usize {
    (width as usize).saturating_sub(FRAME_COLUMNS).max(1)
}

/// One content row: `│ ` + spans padded to the inner width + ` │`.
fn content_row(width: u16, border: Style, spans: Vec<Span>) -> Row {
    let inner = inner_width(width);
    let mut out = Vec::with_capacity(spans.len() + 3);
    out.push(Span::new("│ ", border));
    let mut used = 0usize;
    for span in spans {
        if used >= inner {
            break;
        }
        let text = truncate(&span.text, inner - used);
        if text.is_empty() {
            continue;
        }
        used += UnicodeWidthStr::width(text.as_str());
        out.push(Span::new(text, span.style));
    }
    out.push(Span::new(" ".repeat(inner - used.min(inner)), Style::default()));
    out.push(Span::new(" │", border));
    Row { spans: out }
}

/// One list row: marker, label, and a right-aligned detail column.
fn choice_row(theme: &Theme, width: u16, border: Style, choice: &Choice, on: bool) -> Row {
    let inner = inner_width(width);
    let marker = if on {
        Span::new("▸ ", theme.accent())
    } else if choice.current {
        Span::new("● ", theme.agent())
    } else {
        Span::new("  ", Style::default())
    };
    let label_style = if on { theme.text() } else { theme.muted() };
    let body = inner.saturating_sub(MARKER_COLUMNS);

    // The detail column gets whatever the label leaves, down to nothing: a
    // narrow terminal loses the description, never the name.
    let label = truncate(&choice.label, body);
    let label_width = UnicodeWidthStr::width(label.as_str());
    let mut spans = vec![marker, Span::new(label, label_style)];
    let mut used = MARKER_COLUMNS + label_width;

    if let Some(detail) = &choice.detail {
        let room = body.saturating_sub(label_width);
        if room > 3 {
            let detail = truncate(detail, room - 2);
            let detail_width = UnicodeWidthStr::width(detail.as_str());
            let gap = inner - used - detail_width;
            spans.push(Span::new(" ".repeat(gap), Style::default()));
            spans.push(Span::new(detail, theme.faint()));
            used = inner;
        }
    }
    spans.push(Span::new(" ".repeat(inner - used.min(inner)), Style::default()));
    let mut out = vec![Span::new("│ ", border)];
    out.extend(spans);
    out.push(Span::new(" │", border));
    Row { spans: out }
}

/// A horizontal border carrying an optional left-anchored label.
fn rule(width: u16, border: Style, left: char, right: char, label: Option<(&str, Style)>) -> Row {
    let span = (width as usize).saturating_sub(2);
    let Some((label, style)) = label.filter(|(text, _)| !text.is_empty()) else {
        return Row::styled(format!("{left}{}{right}", "─".repeat(span)), border);
    };
    let text = format!(" {} ", truncate(label, span.saturating_sub(6)));
    let text_width = UnicodeWidthStr::width(text.as_str());
    if text_width + 3 > span {
        return Row::styled(format!("{left}{}{right}", "─".repeat(span)), border);
    }
    Row {
        spans: vec![
            Span::new(format!("{left}─"), border),
            Span::new(text, style),
            Span::new(format!("{}{right}", "─".repeat(span - text_width - 1)), border),
        ],
    }
}

/// Truncate to `limit` display columns without splitting a wide grapheme.
///
/// Shared with [`crate::ui::form`]: one truncation rule for everything drawn
/// inside a panel frame, so a form row and a list row degrade identically.
pub(crate) fn truncate(text: &str, limit: usize) -> String {
    if UnicodeWidthStr::width(text) <= limit {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > limit {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choices(labels: &[&str]) -> Vec<Choice> {
        labels.iter().map(|label| Choice::new(*label)).collect()
    }

    fn labels(select: &Select) -> Vec<String> {
        select.visible().map(|choice| choice.label.clone()).collect()
    }

    fn text(rows: &[Row]) -> String {
        rows.iter().map(Row::plain_text).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn a_local_list_filters_and_reorders_as_you_type() {
        let mut select = Select::local(choices(&["compact", "model", "mcp", "context"]));
        assert_eq!(labels(&select).len(), 4);
        select.insert("mc");
        // `compact` is still a subsequence match, but a prefix beats a scatter.
        assert_eq!(labels(&select).first().map(String::as_str), Some("mcp"));
        assert!(!labels(&select).contains(&"model".to_owned()), "no `c` in `model`");
        select.backspace();
        select.insert("o");
        assert_eq!(labels(&select).first().map(String::as_str), Some("model"));
    }

    #[test]
    fn a_server_list_is_never_reordered_and_typing_asks_for_a_new_one() {
        let mut select = Select::new(Ranking::Server);
        select.set_items(vec![
            Choice::new("zebra.ts"),
            Choice::new("apple.ts"),
        ]);
        assert_eq!(labels(&select), vec!["zebra.ts".to_owned(), "apple.ts".to_owned()]);
        assert!(
            select.insert("a"),
            "a server-ranked list re-queries rather than filtering locally"
        );
        assert!(
            select.is_empty(),
            "candidates for the previous query must not be shown for this one"
        );
        assert!(select.is_loading());
    }

    #[test]
    fn the_list_opens_on_whatever_is_already_in_force() {
        let mut select = Select::new(Ranking::Local);
        select.set_items(vec![
            Choice::new("sonnet"),
            Choice::new("opus").current(true),
        ]);
        assert_eq!(select.selection().map(|c| c.label.as_str()), Some("opus"));
    }

    #[test]
    fn selection_wraps_in_both_directions() {
        let mut select = Select::local(choices(&["one", "two", "three"]));
        select.prev();
        assert_eq!(select.selected(), 2);
        select.next();
        assert_eq!(select.selected(), 0);
    }

    #[test]
    fn fuzzy_prefers_prefixes_then_word_starts_then_scatter() {
        let prefix = fuzzy_score("mod", "model").unwrap();
        let word = fuzzy_score("mod", "the mod file").unwrap();
        let scatter = fuzzy_score("mod", "my old door").unwrap();
        assert!(prefix > word, "{prefix} vs {word}");
        assert!(word > scatter, "{word} vs {scatter}");
        assert_eq!(fuzzy_score("zzz", "model"), None);
        assert_eq!(fuzzy_score("", "anything"), Some(0));
    }

    #[test]
    fn every_panel_row_is_exactly_the_terminal_width() {
        let theme = Theme::lyra();
        let mut select = Select::local(vec![
            Choice::new("opus-5").with_detail("anthropic · 200k"),
            Choice::new("a-model-name-far-too-long-for-a-narrow-terminal")
                .with_detail("a detail that is also much too long"),
        ]);
        select.insert("o");
        let panel = Panel::select("model", select);
        for width in [24u16, 40, 80, 120] {
            let rendered = render(&theme, &panel, width, 6);
            for row in &rendered.rows {
                assert_eq!(
                    row.width(),
                    width as usize,
                    "width {width}: {:?}",
                    row.plain_text()
                );
            }
        }
    }

    #[test]
    fn a_rows_panel_pads_to_its_viewport_so_the_frame_never_collapses() {
        let theme = Theme::lyra();
        let panel = Panel::rows("keys", vec![Row::text("enter  send")]);
        let rendered = render(&theme, &panel, 60, 5);
        assert_eq!(rendered.rows.len(), 3, "one content row plus two borders");
        assert!(text(&rendered.rows).contains("keys"));
        assert!(text(&rendered.rows).contains("enter  send"));
        assert_eq!(rendered.caret, None, "a rows panel takes no keyboard caret");
    }

    #[test]
    fn a_tall_list_scrolls_to_keep_the_highlight_visible() {
        let theme = Theme::lyra();
        let items: Vec<Choice> = (0..20).map(|n| Choice::new(format!("item-{n:02}"))).collect();
        let mut select = Select::local(items);
        for _ in 0..12 {
            select.next();
        }
        let panel = Panel::select("many", select);
        let rendered = render(&theme, &panel, 60, 5);
        assert_eq!(rendered.rows.len(), 5 + 3, "5 content rows, a filter, two borders");
        assert!(text(&rendered.rows).contains("item-12"), "{}", text(&rendered.rows));
    }

    #[test]
    fn an_empty_filter_result_says_so_instead_of_showing_a_hole() {
        let theme = Theme::lyra();
        let mut select = Select::local(choices(&["alpha"]));
        select.insert("zzz");
        let panel = Panel::select("things", select);
        let rendered = render(&theme, &panel, 60, 6);
        assert!(text(&rendered.rows).contains("nothing matches"));
    }

    #[test]
    fn the_popup_keeps_the_order_it_was_given() {
        let theme = Theme::lyra();
        let items = vec![
            CompletionItem::new("zebra.ts", "@zebra.ts"),
            CompletionItem::new("apple.ts", "@apple.ts"),
        ];
        let rows = popup(&theme, &items, 0, 60, 4);
        let drawn = text(&rows);
        assert!(
            drawn.find("zebra.ts") < drawn.find("apple.ts"),
            "the popup must not re-sort: {drawn}"
        );
        for row in &rows {
            assert_eq!(row.width(), 60);
        }
        assert!(popup(&theme, &[], 0, 60, 4).is_empty(), "no items, no frame");
    }

    #[test]
    fn a_rows_overlay_scrolls_within_its_viewport() {
        let mut rows = Rows::new((0..10).map(|n| Row::text(format!("row {n}"))).collect());
        assert_eq!(rows.window(3).len(), 3);
        rows.scroll_down(3);
        assert_eq!(rows.window(3)[0].plain_text(), "row 1");
        for _ in 0..50 {
            rows.scroll_down(3);
        }
        assert_eq!(
            rows.window(3)[2].plain_text(),
            "row 9",
            "scrolling stops with the last row on screen"
        );
        for _ in 0..50 {
            rows.scroll_up();
        }
        assert_eq!(rows.window(3)[0].plain_text(), "row 0");
    }
}
