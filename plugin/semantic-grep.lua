-- :SemanticGrep files [words] opens the files view (the files a sentence is about), :SemanticGrep [words] the live
-- picker of pieces (with a range, the lines' words); :SemanticGrep rebuild makes the project's index again,
-- :SemanticGrep download fetches the local model. No keymaps: see the README for one.
if vim.g.loaded_semantic_grep then return end
vim.g.loaded_semantic_grep = true

vim.api.nvim_create_user_command('SemanticGrep', function(opts) require('semantic-grep').command(opts) end, {
  nargs = '*',
  range = true,
  complete = function(lead) return vim.tbl_filter(function(word) return word:find(lead, 1, true) == 1 end, {'files', 'rebuild', 'download'}) end,
  desc = 'semantic-grep: search by words and meaning [words] | files [words] | rebuild | download',
})
