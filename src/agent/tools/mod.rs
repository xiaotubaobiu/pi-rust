pub mod bash;
pub mod edit_file;
pub mod list_dir;
pub mod read_file;
pub mod write_file;

use crate::agent::tool::AgentTool;

pub fn builtin_tools() -> Vec<AgentTool> {
    vec![
        read_file::tool(),
        write_file::tool(),
        edit_file::tool(),
        list_dir::tool(),
        bash::tool(),
    ]
}
