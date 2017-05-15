# Event subsystem APIs

## User-facing pages

This is mostly configured through gitwed-data repo.

`GET /events/:id/edit`

Login if needed and redirect to `/events/:id`

`GET /events/`

List events. Supports query parameters, see below.

`GET /events/:id`

Page for a specific event. Supports editing if user has the permission.

## JSON APIs

`GET /api/events/:id`

Get full data for a specific event. Event IDs are numeric.

`GET /api/events`

List events. Supports query parameters, see below.

`POST /api/events`

Create a new event (if no `id` attribute in payload), or
update an existing one (with `id` in payload).

`GET /api/centers/:id`

Get specific center. Id is a string like `wroclaw`.

`GET /api/centers`

List centers.

## Event query parameters

Following parameters are supported (with examples):

* `start=2017-03-22` - only list events that don't end before given date; by default current date minus 3 days is used
* `stop=2020-03-22` - only list events that start before the given date; by default `9999-12-31`
* `count=10` - return given number of results; defaults to `100`
* `skip=10` - skip given number of results; defaults to `0`
* `center=wroclaw` - only return events assigned to given center
* `country=pl` - only return events assigned to centers in given country

Events can be held at the center or at a different location. Even if they are held
somewhere in the country side, the `fullcity` in lists (displayed in user-facing list of events as well)
will be the city of the center.
