#!/bin/bash
set -e
increment=${1:-patch}
version=$(npm version ${increment} --no-git-tag-version)
msg="chore: release ${version}"
git add .
git commit -m "$msg"
git tag -a $version -m "$msg"
git push origin $version main
git push
