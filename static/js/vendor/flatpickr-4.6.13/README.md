# Flatpickr 4.6.13

The JavaScript, CSS, and `LICENSE.md` in this directory are unchanged files from
the official `flatpickr@4.6.13` npm distribution. Their content and versions match
the files previously loaded by the application.

- Package metadata: https://registry.npmjs.org/flatpickr/4.6.13
- Distribution: https://registry.npmjs.org/flatpickr/-/flatpickr-4.6.13.tgz
- License: MIT; full upstream text is in `LICENSE.md`.

The downloaded package was verified against its npm integrity value:

```text
sha512-97PMG/aywoYpB4IvbvUJi0RQi8vearvU0oov1WW3k0WZPBMrTQVqekSX5CjSG/M4Q3i6A/0FKXC7RyAoAUUSPw==
```

The integrity values retained by the template and lazy loaders are:

```text
flatpickr.min.js: sha384-5JqMv4L/Xa0hfvtF06qboNdhvuYXUku9ZrhZh3bSk8VXF0A/RuSLHpLsSV9Zqhl6
flatpickr.min.css: sha384-RkASv+6KfBMW9eknReJIJ6b3UnjKOKC5bOUaNgIY778NFbQ8MtWq9Lr/khUgqtTt
```

Keep these upstream files outside the application asset build. To update them,
verify the chosen official npm distribution, replace all three upstream files
together, update the versioned paths and integrity values in the templates and
Study lazy loader, and update this record and the HTTP byte checks. Run the
isolated local-library browser checks, including the retained Calendar with
`STUDY_PLAN_V2=0`, afterward.
