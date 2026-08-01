-- Fix: nflverse uses older team abbreviations in some seasons' play-by-play
-- (LA for Rams, OAK for Raiders, SD for Chargers, STL for Rams, WSH for Commanders).
-- The pressure/pbp scripts emit these, but 002_seed_teams.sql only had the modern
-- codes, so the foreign key on nfl_team_pressure rejected them. Seed the aliases.
insert into nfl_teams (team_abbr, full_name, conference, division, home_stadium) values
  ('LA','Los Angeles Rams','NFC','West','LAR'),
  ('OAK','Las Vegas Raiders','AFC','West','LV'),
  ('SD','Los Angeles Chargers','AFC','West','LAC'),
  ('STL','Los Angeles Rams','NFC','West','LAR'),
  ('WSH','Washington Commanders','NFC','East','WAS')
on conflict (team_abbr) do nothing;
