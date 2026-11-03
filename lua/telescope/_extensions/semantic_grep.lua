-- :Telescope semantic_grep [default_text=words]: semantic-grep's live picker as a Telescope extension.
--   require('telescope').load_extension('semantic_grep')
-- `extensions = {semantic_grep = {...}}` in Telescope's setup goes to require('semantic-grep').setup() if it was not
-- called; the picker's own options (a theme, layout) go with each call: require('telescope').extensions.semantic_grep.semantic_grep(opts).
local has_telescope, telescope = pcall(require, 'telescope')
if not has_telescope then error('semantic_grep: this extension needs telescope.nvim') end

local function pick(opts)
  require('semantic-grep').source() -- set up with defaults if setup() was not called
  require('semantic-grep.picker').telescope(opts or {})
end

return telescope.register_extension({
  setup = function(ext_config)
    if ext_config and next(ext_config) then require('semantic-grep').setup(ext_config) end
  end,
  exports = {semantic_grep = pick},
})
