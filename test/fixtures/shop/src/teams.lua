local M = {}

--- Takes a member off a team; their open tasks go back to the team's queue.
function M.remove_member(team, member)
  for _, task in ipairs(member.tasks) do table.insert(team.queue, task) end
  team.members[member.id] = nil
end

return M
