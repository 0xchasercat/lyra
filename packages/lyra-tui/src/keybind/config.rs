//! User remapping: the `[tui.keys]` table, as **data**.
//!
//! DESIGN.md §4 is explicit that remapping is "data, not code". This module is
//! the whole of it: a TOML table whose keys are [`Action`] ids and whose values
//! are a key spec, a list of key specs, or `false` to unbind.
//!
//! ```toml
//! [tui.keys]
//! steer = "ctrl+g"                 # one key
//! newline = ["shift+enter", "f2"]  # several
//! palette = false                  # unbound
//! ```
//!
//! # Failure policy
//!
//! Nothing here is fatal. A misspelled action id, an unparseable key spec, a
//! value of the wrong type, even a syntactically broken document: each costs its
//! own entry, produces a warning in [`KeyOverrides::warnings`], and leaves every
//! other binding at its default. A config typo must never be the reason a user
//! cannot reach their terminal.
//!
//! An action that appears here replaces its defaults *entirely* rather than
//! adding to them, so `submit = "ctrl+enter"` really does free `Enter`.

use std::collections::HashMap;

use super::{spec, Action};
use crate::input::key::KeyEvent;

/// What a user asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Override {
    /// Use these keys instead of the defaults.
    Keys(Vec<KeyEvent>),
    /// Remove the binding entirely.
    Unbind,
}

/// The parsed `[tui.keys]` table.
#[derive(Debug, Clone, Default)]
pub struct KeyOverrides {
    map: HashMap<Action, Override>,
    warnings: Vec<String>,
}

impl KeyOverrides {
    /// Parse a whole config document and dig out `[tui.keys]`.
    ///
    /// A document with no such table yields no overrides and no warnings — the
    /// common case is a config that says nothing about keys.
    #[must_use]
    pub fn from_document(text: &str) -> Self {
        let table = match text.parse::<toml::Table>() {
            Ok(table) => table,
            Err(error) => {
                return Self {
                    map: HashMap::new(),
                    warnings: vec![format!("config is not valid TOML: {error}")],
                }
            }
        };
        let keys = table
            .get("tui")
            .and_then(toml::Value::as_table)
            .and_then(|tui| tui.get("keys"))
            .and_then(toml::Value::as_table);
        keys.map_or_else(Self::default, Self::from_table)
    }

    /// Parse the `[tui.keys]` table itself.
    #[must_use]
    pub fn from_table(table: &toml::Table) -> Self {
        let mut map = HashMap::new();
        let mut warnings = Vec::new();
        for (id, value) in table {
            let Some(action) = Action::from_id(id) else {
                warnings.push(format!("[tui.keys] unknown action `{id}`"));
                continue;
            };
            match value {
                toml::Value::Boolean(false) => {
                    map.insert(action, Override::Unbind);
                }
                toml::Value::Boolean(true) => {
                    warnings.push(format!(
                        "[tui.keys] `{id} = true` means nothing; use a key spec, \
                         a list of key specs, or `false` to unbind"
                    ));
                }
                toml::Value::String(text) => match spec::parse_key(text) {
                    Ok(key) => {
                        map.insert(action, Override::Keys(vec![key]));
                    }
                    Err(error) => warnings.push(format!("[tui.keys] {id}: {error}")),
                },
                toml::Value::Array(items) => {
                    let mut keys = Vec::with_capacity(items.len());
                    for item in items {
                        let Some(text) = item.as_str() else {
                            warnings
                                .push(format!("[tui.keys] {id}: list entries must be strings"));
                            continue;
                        };
                        match spec::parse_key(text) {
                            Ok(key) => keys.push(key),
                            Err(error) => warnings.push(format!("[tui.keys] {id}: {error}")),
                        }
                    }
                    // An empty list is an unbind written the long way. Treating it
                    // as "no override" would silently restore the defaults the
                    // user was trying to remove.
                    map.insert(
                        action,
                        if keys.is_empty() {
                            Override::Unbind
                        } else {
                            Override::Keys(keys)
                        },
                    );
                }
                other => warnings.push(format!(
                    "[tui.keys] {id}: expected a string, a list of strings or `false`, \
                     found {}",
                    other.type_str()
                )),
            }
        }
        Self { map, warnings }
    }

    /// The override for an action, if any.
    #[must_use]
    pub fn get(&self, action: Action) -> Option<&Override> {
        self.map.get(&action)
    }

    /// Diagnostics collected while parsing.
    #[must_use]
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Whether the table said anything at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybind::{ContextStack, Keymap};

    fn overrides(document: &str) -> KeyOverrides {
        KeyOverrides::from_document(document)
    }

    fn key(text: &str) -> KeyEvent {
        spec::parse_key(text).unwrap()
    }

    #[test]
    fn a_string_value_rebinds_an_action() {
        let table = overrides("[tui.keys]\nsteer = \"ctrl+g\"\n");
        assert!(table.warnings().is_empty(), "{:?}", table.warnings());
        assert_eq!(
            table.get(Action::Steer),
            Some(&Override::Keys(vec![key("ctrl+g")]))
        );
    }

    #[test]
    fn a_list_value_binds_several_keys() {
        let table = overrides("[tui.keys]\nnewline = [\"shift+enter\", \"f2\"]\n");
        assert_eq!(
            table.get(Action::Newline),
            Some(&Override::Keys(vec![key("shift+enter"), key("f2")]))
        );
    }

    #[test]
    fn false_unbinds_and_an_empty_list_means_the_same_thing() {
        let table = overrides("[tui.keys]\npalette = false\nhelp = []\n");
        assert_eq!(table.get(Action::Palette), Some(&Override::Unbind));
        assert_eq!(table.get(Action::Help), Some(&Override::Unbind));
    }

    #[test]
    fn an_override_replaces_the_defaults_rather_than_adding_to_them() {
        let keymap = Keymap::new(&overrides("[tui.keys]\nsubmit = \"ctrl+enter\"\n"));
        let stack = ContextStack::build(false, false, false, false);
        assert_eq!(
            keymap.lookup(key("ctrl+enter"), &stack),
            Some(Action::Submit)
        );
        assert_eq!(
            keymap.lookup(key("enter"), &stack),
            None,
            "rebinding submit must actually free Enter"
        );
    }

    #[test]
    fn an_unbound_action_disappears_from_dispatch_and_from_help() {
        let keymap = Keymap::new(&overrides("[tui.keys]\npalette = false\n"));
        let stack = ContextStack::build(false, false, false, false);
        assert_eq!(keymap.lookup(key("ctrl+p"), &stack), None);
        assert!(keymap.keys_for(Action::Palette).is_empty());
        assert!(!keymap
            .hints(&stack)
            .iter()
            .any(|hint| hint.action == Action::Palette));
    }

    #[test]
    fn every_kind_of_mistake_costs_one_entry_and_nothing_else() {
        let table = overrides(
            "[tui.keys]\n\
             not-an-action = \"ctrl+g\"\n\
             steer = \"ctrl+nonsense\"\n\
             cancel = 7\n\
             help = true\n\
             submit = \"ctrl+enter\"\n",
        );
        assert_eq!(table.warnings().len(), 4, "{:?}", table.warnings());
        assert_eq!(
            table.get(Action::Submit),
            Some(&Override::Keys(vec![key("ctrl+enter")])),
            "the one good entry still applies"
        );
        assert_eq!(table.get(Action::Steer), None, "a bad spec keeps the default");
    }

    #[test]
    fn a_broken_document_is_a_warning_not_a_panic() {
        let table = overrides("[tui.keys\nsteer = ");
        assert_eq!(table.warnings().len(), 1);
        assert!(table.is_empty());
    }

    #[test]
    fn a_config_without_a_keys_table_is_silent() {
        let table = overrides("[tui]\ntheme = \"system\"\n");
        assert!(table.is_empty());
        assert!(table.warnings().is_empty());
    }

    #[test]
    fn a_remap_that_creates_a_conflict_is_reported_by_the_keymap() {
        let keymap = Keymap::new(&overrides("[tui.keys]\nundo = \"ctrl+y\"\n"));
        assert!(
            keymap
                .warnings()
                .iter()
                .any(|warning| warning.contains("ctrl+y")),
            "{:?}",
            keymap.warnings()
        );
    }
}
