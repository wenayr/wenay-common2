# Recent changes

This directory keeps one file per published version **within the latest ten releases**.
It is a rolling window, not the complete release history. Absence from a newer package
does not mean a version was unpublished, undocumented or only a technical release.

For an older version, read its own npm archive. For example:

```sh
npm pack wenay-common2@2.13.0
tar -xOf wenay-common2-2.13.0.tgz package/doc/changes/2.13.0.md
```

Version 2.13.0 was a substantive release with five fixes, and its published archive
contains that change file. It fell outside the ten-version window by 2.20.0; that
package's retained history starts at 2.14.0. Older files are not restored into this
directory when documenting an upgrade across the window.

Rules:
- file name: `<version>.md`, for example `1.0.63.md`;
- each file contains a short commit-style summary of what changed;
- keep only the latest 10 version files, deleting older version files when adding a new one.
