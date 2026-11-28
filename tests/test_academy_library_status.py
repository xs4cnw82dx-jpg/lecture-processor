"""Academy list summaries distinguish an unpublished draft from a paused learner link."""
from tests.test_academy_authors import ADMIN, LIBRARY, create_course, studio as academy_fixture

studio = academy_fixture


def test_course_list_preserves_actual_publication_after_a_learner_link_is_paused(studio):
    course = create_course(studio, ADMIN)
    sharing = LIBRARY + '/' + course['id'] + '/sharing'

    def status():
        row = studio.get(LIBRARY, headers=ADMIN).get_json()['expeditions'][0]
        return row['shareEnabled'], row['hasPublished']

    assert status() == (False, False)
    for enabled in (True, False):
        response = studio.post(sharing, headers=ADMIN, json={'action': 'update_public', 'enabled': enabled})
        assert response.status_code == 200
        assert status() == (enabled, True)
